import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sshpk from 'sshpk';
import SSHConfig from 'ssh-config';

const { generatePrivateKey, parsePrivateKey } = sshpk;

import { findFirstIdentityFileForHost } from './configEvaluator.js';
import type { StructuredError } from './errors.js';
import { SSH_KEY_FILENAME } from './keyResolution.js';
import { logOperation } from './ssh.js';

const keyComment = 'rebel-replit';
const SSH_DIR_MODE = 0o700;
const PRIVATE_KEY_MODE = 0o600;
const PUBLIC_KEY_MODE = 0o644;
const STRUCTURED_SETUP_ERROR = 'STRUCTURED_SETUP_ERROR';

interface StructuredSetupFailure {
  kind: typeof STRUCTURED_SETUP_ERROR;
  error: StructuredError;
}

function ensureComment(pubKey: string): string {
  const parts = pubKey.trim().split(/\s+/);
  if (parts.length < 3) return `${pubKey.trim()} ${keyComment}`;
  return pubKey.trim();
}

function toDisplayPath(filePath: string): string {
  return filePath.replace(os.homedir(), '~');
}

function throwStructuredSetupError(error: StructuredError): never {
  throw {
    kind: STRUCTURED_SETUP_ERROR,
    error,
  } as StructuredSetupFailure;
}

function asStructuredSetupError(err: unknown): StructuredError | null {
  if (!err || typeof err !== 'object') {
    return null;
  }
  const candidate = err as Partial<StructuredSetupFailure>;
  if (candidate.kind === STRUCTURED_SETUP_ERROR && candidate.error) {
    return candidate.error;
  }
  return null;
}

function fsyncParentDirectoryBestEffort(filePath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    const parentDirFd = fs.openSync(path.dirname(filePath), 'r');
    try {
      fs.fsyncSync(parentDirFd);
    } finally {
      fs.closeSync(parentDirFd);
    }
  } catch {
    // best-effort only
  }
}

function atomicWriteFileSync(targetPath: string, content: Buffer | string, mode: number): void {
  const tempPath = `${targetPath}.replit-tmp-${randomUUID()}`;
  const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  let tempFd: number | undefined;

  try {
    tempFd = fs.openSync(tempPath, 'w', mode);
    fs.writeSync(tempFd, data, 0, data.length, 0);
    fs.chmodSync(tempPath, mode);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;

    fs.renameSync(tempPath, targetPath);
    fsyncParentDirectoryBestEffort(targetPath);
  } catch (err) {
    if (tempFd !== undefined) {
      try {
        fs.closeSync(tempFd);
      } catch {
        // best-effort cleanup
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

function cleanupKeyFiles(privateKeyPath: string, publicKeyPath: string): void {
  for (const filePath of [privateKeyPath, publicKeyPath]) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // best-effort cleanup
    }
  }
}

function enforceWindowsKeyAclOrFail(
  privateKeyPath: string,
  publicKeyPath: string,
): void {
  const username = (process.env.USERNAME || '').trim();
  if (!username) {
    cleanupKeyFiles(privateKeyPath, publicKeyPath);
    throwStructuredSetupError({
      ok: false,
      error: 'Cannot harden key file permissions because USERNAME is not set.',
      code: 'WINDOWS_USERNAME_MISSING',
      action_required: 'Set USERNAME in the environment or run replit_setup_ssh from a standard user shell where USERNAME is available.',
      next_step: 'Run `echo %USERNAME%` to confirm USERNAME is set, then retry `replit_setup_ssh`.',
    });
  }

  try {
    execFileSync(
      'icacls',
      [privateKeyPath, '/inheritance:r', '/grant:r', `${username}:R`],
      {
        windowsHide: true,
        timeout: 10_000,
      },
    );
  } catch {
    cleanupKeyFiles(privateKeyPath, publicKeyPath);
    throwStructuredSetupError({
      ok: false,
      error: 'Failed to harden private-key file ACLs on Windows.',
      code: 'PERMISSION_HARDENING_FAILED',
      action_required: 'icacls failed to set restrictive ACL on the key file. Manually run icacls <path> /inheritance:r /grant:r %USERNAME%:R, or delete the file and retry replit_setup_ssh from an elevated shell.',
      next_step: "Verify icacls is on PATH and the user has permission to modify the file's ACL.",
    });
  }
}

function writeSshConfigAtomically(
  configPath: string,
  updatedConfig: string,
  backupExistingConfig: boolean,
): string | null {
  let backupPath: string | null = null;
  try {
    if (backupExistingConfig && fs.existsSync(configPath)) {
      backupPath = `${configPath}.replit-backup-${Date.now()}`;
      fs.copyFileSync(configPath, backupPath);
      try {
        fs.chmodSync(backupPath, PRIVATE_KEY_MODE);
      } catch {
        // best-effort; backup readability is less critical than preserving it
      }
    }

    atomicWriteFileSync(configPath, updatedConfig, PRIVATE_KEY_MODE);
    return backupPath;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code || 'unknown error';
    throwStructuredSetupError({
      ok: false,
      error: `Failed to update SSH config (~/.ssh/config): ${code}.`,
      code: 'CONFIG_REWRITE_FAILED',
      action_required: 'The SSH config rewrite failed. Check that ~/.ssh is writable and retry.',
      next_step: 'Retry `replit_setup_ssh`. If it still fails, check disk space and permissions on ~/.ssh.',
    });
  }
}

export async function runSetupSsh(
  forceRegenerate: boolean,
  backupExistingConfig = false,
): Promise<string> {
  const startTime = Date.now();

  try {
    const sshDir = path.join(os.homedir(), '.ssh');
    const privateKeyPath = path.join(sshDir, SSH_KEY_FILENAME);
    const publicKeyPath = path.join(sshDir, `${SSH_KEY_FILENAME}.pub`);
    const configPath = path.join(sshDir, 'config');
    const isWindows = process.platform === 'win32';

    let alreadyExisted = false;
    let publicKeyContent: string;
    let configBackupPath: string | null = null;

    const keyExistedBeforeThisCall = fs.existsSync(privateKeyPath);

    if (!forceRegenerate && keyExistedBeforeThisCall) {
      alreadyExisted = true;
      try {
        publicKeyContent = ensureComment(fs.readFileSync(publicKeyPath, 'utf-8'));
        atomicWriteFileSync(publicKeyPath, `${publicKeyContent}\n`, PUBLIC_KEY_MODE);
        fs.chmodSync(publicKeyPath, PUBLIC_KEY_MODE);
      } catch {
        const existingKey = fs.readFileSync(privateKeyPath);
        const parsed = parsePrivateKey(existingKey, 'auto');
        publicKeyContent = ensureComment(parsed.toPublic().toString('ssh'));
        atomicWriteFileSync(publicKeyPath, `${publicKeyContent}\n`, PUBLIC_KEY_MODE);
        fs.chmodSync(publicKeyPath, PUBLIC_KEY_MODE);
      }
    } else {
      const key = generatePrivateKey('ed25519');
      const privateKeyBuffer = key.toBuffer('openssh');
      publicKeyContent = ensureComment(key.toPublic().toString('ssh'));

      if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { recursive: true, mode: SSH_DIR_MODE });
      }

      const existingPrivateKeyStats = fs.lstatSync(privateKeyPath, {
        throwIfNoEntry: false,
      });
      if (existingPrivateKeyStats?.isSymbolicLink()) {
        throwStructuredSetupError({
          ok: false,
          error: `Refusing to overwrite symlinked private key path "${toDisplayPath(privateKeyPath)}".`,
          code: 'KEY_WRITE_REJECTED_SYMLINK',
          action_required: 'Replace the symlink with a regular file path before setting up SSH keys.',
          next_step: 'Remove the symlinked key file and rerun `replit_setup_ssh`.',
        });
      }

      atomicWriteFileSync(privateKeyPath, privateKeyBuffer, PRIVATE_KEY_MODE);
      fs.chmodSync(privateKeyPath, PRIVATE_KEY_MODE);

      atomicWriteFileSync(publicKeyPath, `${publicKeyContent}\n`, PUBLIC_KEY_MODE);
      fs.chmodSync(publicKeyPath, PUBLIC_KEY_MODE);

      if (isWindows) {
        enforceWindowsKeyAclOrFail(privateKeyPath, publicKeyPath);
      }
    }

    let configContent = '';
    try {
      configContent = fs.readFileSync(configPath, 'utf-8');
    } catch {
      // Config file doesn't exist yet — start with empty
    }

    const config = SSHConfig.parse(configContent);
    let configUpdated = false;
    let usingExistingKey = false;
    let existingKeyPath = '';

    const existingBlock = config.find({ Host: '*.replit.dev' });
    if (!existingBlock) {
      // NB: this ~/.ssh/config entry is for the user's OpenSSH command-line
      // client only. The MCP server itself uses node `ssh2` (see
      // src/hostVerification.ts) and applies trust-on-first-use against a
      // separate known-hosts file. Do NOT add a StrictHostKeyChecking key
      // here — historically `accept-new` was written, which gave the false
      // impression that the MCP server was performing host-key checks when
      // it was not.
      config.append({
        Host: '*.replit.dev',
        Port: '22',
        IdentityFile: `~/.ssh/${SSH_KEY_FILENAME}`,
      });
      configUpdated = true;
    } else {
      const rawPath = findFirstIdentityFileForHost(config, 'test.replit.dev');
      if (rawPath) {
        const resolved = path.normalize(rawPath.replace(/^~/, os.homedir()));
        if (resolved !== path.normalize(privateKeyPath) && fs.existsSync(resolved)) {
          usingExistingKey = true;
          existingKeyPath = resolved;
        }
      }
    }

    if (configUpdated) {
      const updatedConfig = SSHConfig.stringify(config);
      configBackupPath = writeSshConfigAtomically(
        configPath,
        updatedConfig,
        backupExistingConfig,
      );
    }

    logOperation('replit_setup_ssh', 'local', '~/.ssh', 'ok', Date.now() - startTime);

    if (usingExistingKey && existingKeyPath && !forceRegenerate) {
      let activePublicKey = publicKeyContent;
      try {
        const existingPubPath = existingKeyPath + '.pub';
        if (fs.existsSync(existingPubPath)) {
          activePublicKey = fs.readFileSync(existingPubPath, 'utf-8').trim();
        } else {
          const existingPrivate = fs.readFileSync(existingKeyPath);
          const parsed = parsePrivateKey(existingPrivate, 'auto');
          activePublicKey = parsed.toPublic().toString('ssh');
        }
      } catch {
        console.error('[replit-ssh] Warning: could not read public key for configured IdentityFile');
      }

      const displayKeyPath = existingKeyPath.replace(os.homedir(), '~');

      return JSON.stringify({
        ok: true,
        publicKey: activePublicKey,
        configuredKey: displayKeyPath,
        configUpdated,
        ...(configBackupPath ? { configBackupPath: toDisplayPath(configBackupPath) } : {}),
        alreadyExisted,
        usingExistingKey: true,
        note: `Your SSH config already has a *.replit.dev entry pointing to "${displayKeyPath}". The MCP server will use that key (matching OpenSSH behavior).`,
        nextSteps: `Your existing SSH setup for Replit is detected. The MCP server will use the key at ${displayKeyPath}. Verify the publicKey above is registered at replit.com → Account → SSH Keys.`,
      });
    }

    if (usingExistingKey && existingKeyPath && forceRegenerate) {
      const displayKeyPath = existingKeyPath.replace(os.homedir(), '~');
      return JSON.stringify({
        ok: true,
        publicKey: publicKeyContent,
        configuredKey: displayKeyPath,
        configUpdated,
        ...(configBackupPath ? { configBackupPath: toDisplayPath(configBackupPath) } : {}),
        alreadyExisted: false,
        replacedExistingKey: true,
        configMismatch: true,
        warning: `A new SSH key was generated at ~/.ssh/${SSH_KEY_FILENAME}. However, your SSH config still points to "${displayKeyPath}" for *.replit.dev hosts. Either:\n1. Update your SSH config to use ~/.ssh/${SSH_KEY_FILENAME}, or\n2. Add this new key to replit.com → Account → SSH Keys alongside your existing key.`,
        nextSteps: `Copy the public key above and add it at replit.com → Account → SSH Keys. Note: your SSH config currently uses a different key — see the warning above.`,
      });
    }

    const baseNextSteps = 'Your SSH key has been generated. To connect to Replit projects:\n\n1. Copy the public key above\n2. Go to replit.com → Account → SSH Keys\n3. Click \'Add SSH Key\' and paste it\n4. Save\n\nThen open a Replit project in your browser and copy the SSH command to connect.';

    const replacedExistingKey = forceRegenerate && keyExistedBeforeThisCall;

    return JSON.stringify({
      ok: true,
      publicKey: publicKeyContent,
      configUpdated,
      ...(configBackupPath ? { configBackupPath: toDisplayPath(configBackupPath) } : {}),
      alreadyExisted,
      ...(replacedExistingKey ? {
        replacedExistingKey: true,
        warning: 'Your old SSH key was replaced with a new one. You MUST update it at replit.com → Account → SSH Keys — remove the old key and add the new one above. The old key will no longer work.',
      } : {}),
      nextSteps: baseNextSteps,
    });
  } catch (err: unknown) {
    logOperation('replit_setup_ssh', 'local', '~/.ssh', 'error', Date.now() - startTime);

    const structuredError = asStructuredSetupError(err);
    if (structuredError) {
      return JSON.stringify(structuredError);
    }

    const message = (err as Error).message || 'Unknown error';
    const code = (err as NodeJS.ErrnoException).code || '';

    if (code === 'EACCES' || message.includes('permission denied')) {
      return JSON.stringify({
        ok: false,
        error: 'Permission denied when setting up SSH keys.',
        code: 'CONFIG_REWRITE_FAILED',
        action_required: 'The SSH directory or key files may have restrictive permissions.',
        next_step: 'Check the permissions on your .ssh directory and retry `replit_setup_ssh`.',
      });
    }

    console.error(`[replit-ssh] SSH setup error: code=${code} message=${message}`);
    return JSON.stringify({
      ok: false,
      error: 'Failed to set up SSH keys.',
      code: 'KEY_GENERATION_FAILED',
      action_required: 'An unexpected error occurred during SSH key setup.',
      next_step: 'Retry `replit_setup_ssh`. If the problem persists, check that you have write access to your home directory.',
    });
  }
}
