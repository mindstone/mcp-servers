import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sshpk from 'sshpk';
import SSHConfig from 'ssh-config';

const { generatePrivateKey, parsePrivateKey } = sshpk;

import { SSH_KEY_FILENAME } from './keyResolution.js';
import { logOperation } from './ssh.js';

const keyComment = 'rebel-replit';

function ensureComment(pubKey: string): string {
  const parts = pubKey.trim().split(/\s+/);
  if (parts.length < 3) return `${pubKey.trim()} ${keyComment}`;
  return pubKey.trim();
}

export async function runSetupSsh(forceRegenerate: boolean): Promise<string> {
  const startTime = Date.now();

  try {
    const sshDir = path.join(os.homedir(), '.ssh');
    const privateKeyPath = path.join(sshDir, SSH_KEY_FILENAME);
    const publicKeyPath = path.join(sshDir, `${SSH_KEY_FILENAME}.pub`);
    const configPath = path.join(sshDir, 'config');
    const isWindows = process.platform === 'win32';

    let alreadyExisted = false;
    let publicKeyContent: string;

    const keyExistedBeforeThisCall = fs.existsSync(privateKeyPath);

    if (!forceRegenerate && keyExistedBeforeThisCall) {
      alreadyExisted = true;
      try {
        publicKeyContent = ensureComment(fs.readFileSync(publicKeyPath, 'utf-8'));
        fs.writeFileSync(publicKeyPath, publicKeyContent + '\n', 'utf-8');
      } catch {
        const existingKey = fs.readFileSync(privateKeyPath);
        const parsed = parsePrivateKey(existingKey, 'auto');
        publicKeyContent = ensureComment(parsed.toPublic().toString('ssh'));
        fs.writeFileSync(publicKeyPath, publicKeyContent + '\n', 'utf-8');
      }
    } else {
      const key = generatePrivateKey('ed25519');
      const privateKeyBuffer = key.toBuffer('openssh');
      publicKeyContent = ensureComment(key.toPublic().toString('ssh'));

      if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
      }

      fs.writeFileSync(privateKeyPath, privateKeyBuffer, { mode: 0o600 });

      fs.writeFileSync(publicKeyPath, publicKeyContent + '\n', 'utf-8');

      if (isWindows) {
        try {
          execFileSync('icacls', [privateKeyPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME || ''}:R`], {
            windowsHide: true,
            timeout: 10_000,
          });
        } catch (icaclsErr: unknown) {
          console.error(`[replit-ssh] Warning: Could not set Windows file permissions on SSH key: ${(icaclsErr as Error).message}`);
        }
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
      config.append({
        Host: '*.replit.dev',
        Port: '22',
        IdentityFile: `~/.ssh/${SSH_KEY_FILENAME}`,
        StrictHostKeyChecking: 'accept-new',
      });
      configUpdated = true;
    } else {
      const computed = config.compute('test.replit.dev');
      const existingIdentityFile = computed.IdentityFile;
      const rawPath = Array.isArray(existingIdentityFile) ? existingIdentityFile[0] : existingIdentityFile;
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
      fs.writeFileSync(configPath, updatedConfig, 'utf-8');
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
      alreadyExisted,
      ...(replacedExistingKey ? {
        replacedExistingKey: true,
        warning: 'Your old SSH key was replaced with a new one. You MUST update it at replit.com → Account → SSH Keys — remove the old key and add the new one above. The old key will no longer work.',
      } : {}),
      nextSteps: baseNextSteps,
    });
  } catch (err: unknown) {
    logOperation('replit_setup_ssh', 'local', '~/.ssh', 'error', Date.now() - startTime);
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
