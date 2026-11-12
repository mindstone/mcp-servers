/**
 * Wise authentication module.
 *
 * Token resolution order (first match wins):
 *   1. `WISE_API_TOKEN` env var (host-injected configuration)
 *   2. credentials.json written by `configure_wise` (via the host bridge when
 *      available, else the local config dir)
 *
 * The API token is a single per-user credential that sees every Wise profile
 * (personal + business) the user can access, so unlike subdomain-keyed
 * connectors there is one credential slot, not an account list.
 *
 * Environment: each token goes to the Wise host of its own source. An
 * env-var token uses `WISE_ENVIRONMENT=production|sandbox` (default
 * production); a stored token uses the environment saved with it, which
 * `WISE_ENVIRONMENT` does not override. Only the two fixed Wise hosts are
 * reachable — there is no arbitrary base-URL override, so a poisoned env var
 * cannot redirect tokens to an attacker host.
 *
 * File permissions:
 * - credentials.json: 0o600 (read/write owner only), written atomically
 * - config directory: 0o700 (rwx owner only)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { WiseCredentials, WiseEnvironment } from './types.js';
import { atomicCredentialWrite } from './utils/atomicCredentialWrite.js';

const CONFIG_PATH = process.env.WISE_CONFIG_PATH || path.join(os.homedir(), '.mcp', 'wise');
const CREDENTIALS_FILE = path.join(CONFIG_PATH, 'credentials.json');

export function getConfigPath(): string {
  return CONFIG_PATH;
}

/** The environment named by `WISE_ENVIRONMENT` (default production). */
export function getEnvironment(): WiseEnvironment {
  return process.env.WISE_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
}

/** Base URL for the Wise API: a fixed allow-list of the two Wise hosts. */
export function getApiBaseUrl(environment: WiseEnvironment): string {
  return environment === 'sandbox' ? 'https://api.wise-sandbox.com' : 'https://api.wise.com';
}

/**
 * Load stored credentials from credentials.json.
 *
 * A symlink at the path is refused, by an `lstat` of the final component and
 * by `O_NOFOLLOW` on the open where the platform defines it, matching the
 * write path's refusal. The file is then read through the opened descriptor
 * (open → fstat → read). A missing, unreadable, corrupt, symlinked or
 * non-regular file fails closed to "no credentials", which surfaces as the
 * observable "not connected" error from every tool.
 */
export function loadCredentials(): WiseCredentials | null {
  const envToken = process.env.WISE_API_TOKEN;
  if (envToken && envToken.trim() !== '') {
    return { apiToken: envToken.trim(), environment: getEnvironment() };
  }

  let fd: number | undefined;
  try {
    if (fs.lstatSync(CREDENTIALS_FILE).isSymbolicLink()) {
      console.error('[wise] credentials file rejected: path is a symbolic link');
      return null;
    }
    fd = fs.openSync(
      CREDENTIALS_FILE,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
    );
    if (!fs.fstatSync(fd).isFile()) return null;
    const raw = fs.readFileSync(fd, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed.apiToken === 'string' && parsed.apiToken.length > 0) {
      return {
        apiToken: parsed.apiToken,
        environment: parsed.environment === 'sandbox' ? 'sandbox' : 'production',
        connectedAt: typeof parsed.connectedAt === 'string' ? parsed.connectedAt : undefined,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Persist credentials: a temp file created exclusively, then renamed over the
 * target, so a reader never sees a partial file, a pre-existing file is
 * replaced at 0o600 rather than keeping looser permissions, and a symlink at
 * the path is refused. Throws on failure; the error can quote the path, so
 * callers report fixed text.
 */
export async function saveCredentials(credentials: WiseCredentials): Promise<void> {
  await atomicCredentialWrite(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

/**
 * Delete stored credentials. Returns true if a file was removed.
 */
export function removeCredentials(): boolean {
  try {
    fs.unlinkSync(CREDENTIALS_FILE);
    return true;
  } catch {
    return false;
  }
}
