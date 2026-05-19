import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sshpk from 'sshpk';
import SSHConfig from 'ssh-config';

const { parsePrivateKey } = sshpk;

import type { StructuredError } from './errors.js';

export const SSH_KEY_FILENAME = 'rebel-replit';
export const SSH_KEY_PATH = path.join(os.homedir(), '.ssh', SSH_KEY_FILENAME);

export type KeyResolution =
  | { source: 'config'; keyPath: string }
  | { source: 'default'; keyPath: string }
  | { source: 'error'; error: StructuredError };

export function resolveKeyPathForHost(host: string): KeyResolution {
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  let configContent: string | null = null;

  try {
    configContent = fs.readFileSync(configPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { source: 'default', keyPath: SSH_KEY_PATH };
    }
    return {
      source: 'error',
      error: {
        ok: false,
        error: `Cannot read SSH config (~/.ssh/config): ${code || 'unknown error'}`,
        resolution: 'Check file permissions on ~/.ssh/config, or run replit_setup_ssh to create a fresh config.',
        next_step: { action: 'Ask Rebel to set up Replit SSH to repair the configuration.' },
      },
    };
  }

  let config: ReturnType<typeof SSHConfig.parse>;
  try {
    config = SSHConfig.parse(configContent);
  } catch {
    return {
      source: 'error',
      error: {
        ok: false,
        error: 'SSH config (~/.ssh/config) is malformed and cannot be parsed.',
        resolution: 'Fix the syntax in ~/.ssh/config, or run replit_setup_ssh to add the Replit entry.',
        next_step: { action: 'Ask Rebel to set up Replit SSH, or manually repair ~/.ssh/config.' },
      },
    };
  }

  const computed = config.compute(host);
  const identityFile = computed.IdentityFile;

  if (!identityFile) {
    return { source: 'default', keyPath: SSH_KEY_PATH };
  }

  const rawPath = Array.isArray(identityFile) ? identityFile[0] : identityFile;
  if (!rawPath) {
    return { source: 'default', keyPath: SSH_KEY_PATH };
  }

  const resolved = path.normalize(rawPath.replace(/^~/, os.homedir()));

  if (!fs.existsSync(resolved)) {
    return {
      source: 'error',
      error: {
        ok: false,
        error: `SSH config specifies key "${rawPath}" for Replit hosts, but the file does not exist.`,
        resolution: 'Either create the missing key file, update ~/.ssh/config to point to the correct key, or run replit_setup_ssh to set up a new key.',
        next_step: { action: 'Run replit_setup_ssh to generate a new key, or fix the IdentityFile path in ~/.ssh/config.' },
      },
    };
  }

  return { source: 'config', keyPath: resolved };
}

export function readSshKey(keyPath: string): { key: Buffer } | StructuredError {
  try {
    const key = fs.readFileSync(keyPath);
    return { key };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        error: 'Replit SSH key not found.',
        resolution: 'You need to set up SSH keys for Replit before connecting.',
        next_step: { action: 'Ask Rebel to set up Replit SSH — it will generate keys and guide you through adding them to your Replit account.' },
      };
    }
    if (code === 'EACCES') {
      return {
        ok: false,
        error: 'Cannot read Replit SSH key — permission denied.',
        resolution: 'The SSH key file permissions may need repair.',
        next_step: { action: 'Ask Rebel to set up Replit SSH to repair file permissions.' },
      };
    }
    return {
      ok: false,
      error: 'Failed to read Replit SSH key.',
      resolution: 'There was an unexpected error reading the SSH key file.',
      next_step: { action: 'Ask Rebel to set up Replit SSH to regenerate the key.' },
    };
  }
}

export function validatePrivateKey(
  keyBuffer: Buffer,
):
  | { valid: true; type: string; fingerprint: string }
  | { valid: false; error: string } {
  try {
    const parsed = parsePrivateKey(keyBuffer, 'auto');
    const pubKey = parsed.toPublic();
    return {
      valid: true,
      type: parsed.type,
      fingerprint: pubKey.fingerprint('sha256').toString(),
    };
  } catch (err: unknown) {
    return {
      valid: false,
      error: `Key parse failed: ${(err as Error).message}`,
    };
  }
}
