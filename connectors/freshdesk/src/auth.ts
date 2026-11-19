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
 * - accounts.json: 0o600 (read/write owner only), a regular file (a symlink
 *   at that path is refused on read and on write)
 * - config directory: 0o700 (rwx owner only)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AccountsConfig, AccountInfo, FreshdeskAccount } from './types.js';
import { FreshdeskError } from './types.js';
import { atomicCredentialWrite } from './utils/atomicCredentialWrite.js';

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
 * The path is lstat-ed first, so a symlink (including a dangling one) or any
 * other non-regular entry is refused rather than followed. The file is then
 * opened with O_NOFOLLOW where the platform defines it (a link swapped in
 * after the lstat fails the open with ELOOP) and read through the file
 * descriptor (open → fstat → read), so the bytes read are those of the
 * regular file that was checked. The open is non-blocking so a FIFO at the
 * config path cannot stall every tool invocation waiting for a writer. A
 * missing, symlinked, unreadable, corrupt, or non-regular file fails closed
 * to "no accounts" — including resetting previously loaded credentials —
 * which surfaces as the observable "No Freshdesk account connected" error
 * from every tool.
 *
 * Returns `true` when the load was healthy — including a legitimately
 * absent file (ENOENT from the lstat, the normal "no accounts yet" state) —
 * and `false` when anything else is at that path but could not be read or
 * parsed as a regular accounts file (a symlink, a non-regular file, a read
 * or parse failure, or an entry that vanished between the lstat and the
 * open). Write paths
 * (`upsertAccount` / `removeAccount`) MUST refuse to save after a `false`
 * return: the in-memory config has been reset to empty, and saving it
 * would truncate the file and silently destroy every other stored
 * account's credentials.
 */
export function loadAccounts(): boolean {
  const accountsPath = path.join(CONFIG_PATH, 'accounts.json');
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(accountsPath);
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
  }
  if (!entry.isFile()) {
    accountsConfig = { accounts: [] };
    return false;
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(
      accountsPath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
    );
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
  } catch {
    // The lstat saw a regular file, so any failure here (ELOOP from a link
    // swapped in, or even ENOENT from a file removed since) is unhealthy:
    // the on-disk config may still hold accounts a save would destroy.
    accountsConfig = { accounts: [] };
    return false;
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
 * Save accounts.json atomically with secure file permissions.
 *
 * The shared helper writes a temp file (exclusive create, O_NOFOLLOW where
 * available, mode 0o600) in the 0o700 config directory, fsyncs it, renames
 * it over accounts.json and fsyncs the directory, so a crash mid-save leaves
 * the old file whole. It refuses a symlinked accounts.json, and the rename
 * replaces the directory entry rather than writing through a link. The
 * in-memory config is updated only once the write has succeeded.
 */
export async function saveAccounts(config: AccountsConfig): Promise<void> {
  const accountsPath = path.join(CONFIG_PATH, 'accounts.json');
  await atomicCredentialWrite(accountsPath, JSON.stringify(config, null, 2), { mode: 0o600 });
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
 *
 * The change is made on a copy of the config, so a failed save leaves the
 * in-memory config as it was.
 */
export async function removeAccount(domain: string): Promise<boolean> {
  if (!loadAccounts()) assertAccountsReadable();

  const idx = accountsConfig.accounts.findIndex((a) => a.domain === domain);
  if (idx < 0) return false;

  const next: AccountsConfig = { ...accountsConfig, accounts: [...accountsConfig.accounts] };
  next.accounts.splice(idx, 1);

  // Update default if the removed domain was the default
  if (next.defaultDomain === domain) {
    next.defaultDomain = next.accounts[0]?.domain;
  }

  await saveAccounts(next);
  return true;
}

/**
 * Add or update an account. Saves to disk with proper permissions.
 *
 * The change is made on a copy of the config, so a failed save leaves the
 * in-memory config as it was.
 */
export async function upsertAccount(info: AccountInfo): Promise<void> {
  if (!loadAccounts()) assertAccountsReadable();

  const next: AccountsConfig = { ...accountsConfig, accounts: [...accountsConfig.accounts] };
  const idx = next.accounts.findIndex((a) => a.domain === info.domain);
  if (idx >= 0) {
    next.accounts[idx] = info;
  } else {
    next.accounts.push(info);
  }

  // Set default if this is the first account
  if (!next.defaultDomain) {
    next.defaultDomain = info.domain;
  }

  await saveAccounts(next);
}

// Initialize accounts on startup
loadAccounts();
