/**
 * Freshdesk authentication and multi-account management module.
 *
 * Supports multiple Freshdesk accounts stored in a file-backed accounts.json.
 * Hot-reloads accounts from disk on every getAccount() call to pick up
 * external changes (e.g. from the host app bridge).
 *
 * Auth format: Basic base64(apiKey:X)
 *
 * File permissions:
 * - accounts.json: 0o600 (read/write owner only)
 * - config directory: 0o700 (rwx owner only)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AccountsConfig, AccountInfo, FreshdeskAccount } from './types.js';
import { FreshdeskError } from './types.js';

const CONFIG_PATH =
  process.env.FRESHDESK_CONFIG_PATH || path.join(os.homedir(), '.mcp', 'freshdesk');

let accountsConfig: AccountsConfig = { accounts: [] };

/**
 * Returns the config directory path.
 */
export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Load accounts from accounts.json.
 * Called on every getAccount() call to support hot-reload.
 *
 * The file is opened once and read through the file descriptor (open →
 * fstat → read) so it cannot be swapped between a path-level existence
 * check and the read (check-then-use race). The open is non-blocking so a
 * FIFO at the config path cannot stall every tool invocation waiting for
 * a writer. A missing, unreadable, corrupt, or non-regular file fails
 * closed to "no accounts" — including resetting previously loaded
 * credentials — which surfaces as the observable "No Freshdesk account
 * connected" error from every tool.
 *
 * Returns `true` when the load was healthy — including a legitimately
 * absent file (ENOENT, the normal "no accounts yet" state) — and `false`
 * when the file exists but could not be read or parsed. Write paths
 * (`upsertAccount` / `removeAccount`) MUST refuse to save after a `false`
 * return: the in-memory config has been reset to empty, and saving it
 * would truncate the file and silently destroy every other stored
 * account's credentials.
 */
export function loadAccounts(): boolean {
  const accountsPath = path.join(CONFIG_PATH, 'accounts.json');
  let fd: number | undefined;
  try {
    fd = fs.openSync(accountsPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) {
      accountsConfig = { accounts: [] };
      return false;
    }
    const raw = fs.readFileSync(fd, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && Array.isArray(parsed.accounts)) {
      accountsConfig = {
        accounts: parsed.accounts as AccountInfo[],
        defaultDomain: typeof parsed.defaultDomain === 'string' ? parsed.defaultDomain : undefined,
      };
      return true;
    }
    accountsConfig = { accounts: [] };
    return false;
  } catch (error) {
    accountsConfig = { accounts: [] };
    // A legitimately absent file is the normal "no accounts yet" state; any
    // other failure means the on-disk config may still hold accounts the
    // in-memory reset would destroy on the next save.
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Get the current in-memory accounts config (for listing, etc.).
 */
export function getAccountsConfig(): AccountsConfig {
  return accountsConfig;
}

/**
 * Get an account by domain, with hot-reload support.
 * If no domain specified, returns the default or first account.
 */
export function getAccount(domain?: string): FreshdeskAccount | undefined {
  // Hot-reload: always reload accounts from disk
  loadAccounts();

  if (accountsConfig.accounts.length === 0) return undefined;

  let info: AccountInfo | undefined;

  if (domain) {
    info = accountsConfig.accounts.find((a) => a.domain === domain);
  } else {
    const defaultDom = accountsConfig.defaultDomain;
    if (defaultDom) {
      info = accountsConfig.accounts.find((a) => a.domain === defaultDom);
    }
    if (!info) {
      info = accountsConfig.accounts[0];
    }
  }

  if (!info) return undefined;

  return {
    domain: info.domain,
    apiKey: info.apiKey,
    agentEmail: info.agentEmail,
  };
}

/**
 * Save accounts.json with secure file permissions.
 *
 * The file is opened with O_NOFOLLOW so a symlink planted at accounts.json
 * cannot redirect the write into an attacker-chosen target, and chmodded to
 * 0o600 through the descriptor whether or not the file pre-existed (the
 * mode argument to open applies only at creation). O_NOFOLLOW is
 * unavailable on some platforms (e.g. Windows); the mode enforcement still
 * applies there.
 */
export function saveAccounts(config: AccountsConfig): void {
  // Ensure config directory exists with 0o700 permissions
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(CONFIG_PATH, { recursive: true, mode: 0o700 });
  }

  const accountsPath = path.join(CONFIG_PATH, 'accounts.json');
  const fd = fs.openSync(
    accountsPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(config, null, 2));
  } finally {
    fs.closeSync(fd);
  }

  // Update in-memory state
  accountsConfig = config;
}

/**
 * Refuse a read-modify-write when the on-disk accounts.json could not be
 * read or parsed. loadAccounts() has reset the in-memory config to empty in
 * that state, so saving would truncate the file and silently destroy every
 * other stored account's credentials — fail loudly instead.
 */
function assertAccountsReadable(): void {
  throw new FreshdeskError(
    'Stored accounts could not be read; refusing to modify them',
    'ACCOUNTS_UNREADABLE',
    'The accounts file exists but could not be read or parsed. Fix or remove it and try again.',
  );
}

/**
 * Remove an account by domain. Returns true if found and removed.
 */
export function removeAccount(domain: string): boolean {
  if (!loadAccounts()) assertAccountsReadable();

  const idx = accountsConfig.accounts.findIndex((a) => a.domain === domain);
  if (idx < 0) return false;

  accountsConfig.accounts.splice(idx, 1);

  // Update default if the removed domain was the default
  if (accountsConfig.defaultDomain === domain) {
    accountsConfig.defaultDomain = accountsConfig.accounts[0]?.domain;
  }

  saveAccounts(accountsConfig);
  return true;
}

/**
 * Add or update an account. Saves to disk with proper permissions.
 */
export function upsertAccount(info: AccountInfo): void {
  if (!loadAccounts()) assertAccountsReadable();

  const idx = accountsConfig.accounts.findIndex((a) => a.domain === info.domain);
  if (idx >= 0) {
    accountsConfig.accounts[idx] = info;
  } else {
    accountsConfig.accounts.push(info);
  }

  // Set default if this is the first account
  if (!accountsConfig.defaultDomain) {
    accountsConfig.defaultDomain = info.domain;
  }

  saveAccounts(accountsConfig);
}

// Initialize accounts on startup
loadAccounts();
