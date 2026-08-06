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
 * Environment selection: `WISE_ENVIRONMENT=production|sandbox` (default
 * production). Only the two fixed Wise hosts are reachable — there is no
 * arbitrary base-URL override, so a poisoned env var cannot redirect tokens
 * to an attacker host.
 *
 * File permissions:
 * - credentials.json: 0o600 (read/write owner only)
 * - config directory: 0o700 (rwx owner only)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { WiseCredentials, WiseEnvironment } from './types.js';

const CONFIG_PATH = process.env.WISE_CONFIG_PATH || path.join(os.homedir(), '.mcp', 'wise');
const CREDENTIALS_FILE = path.join(CONFIG_PATH, 'credentials.json');

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getEnvironment(): WiseEnvironment {
  return process.env.WISE_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
}

/**
 * Base URL for the Wise API. Fixed allow-list of Wise hosts; sandbox is
 * opt-in via WISE_ENVIRONMENT=sandbox.
 */
export function getApiBaseUrl(): string {
  return getEnvironment() === 'sandbox'
    ? 'https://api.wise-sandbox.com'
    : 'https://api.wise.com';
}

/**
 * Load stored credentials from credentials.json.
 *
 * The file is opened once and read through the file descriptor (open →
 * fstat → read) so it cannot be swapped between a path-level existence
 * check and the read (check-then-use race). A missing, unreadable, corrupt,
 * or non-regular file fails closed to "no credentials", which surfaces as
 * the observable "not connected" error from every tool.
 */
export function loadCredentials(): WiseCredentials | null {
  const envToken = process.env.WISE_API_TOKEN;
  if (envToken && envToken.trim() !== '') {
    return { apiToken: envToken.trim(), environment: getEnvironment() };
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(CREDENTIALS_FILE, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
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
 * Persist credentials with secure file permissions.
 */
export function saveCredentials(credentials: WiseCredentials): void {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(CONFIG_PATH, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
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
