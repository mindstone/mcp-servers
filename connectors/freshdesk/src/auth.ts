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
 */
export function loadAccounts(): void {
  const accountsPath = path.join(CONFIG_PATH, 'accounts.json');
  try {
    if (fs.existsSync(accountsPath)) {
      const raw = fs.readFileSync(accountsPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && Array.isArray(parsed.accounts)) {
        accountsConfig = {
          accounts: parsed.accounts as AccountInfo[],
          defaultDomain: typeof parsed.defaultDomain === 'string' ? parsed.defaultDomain : undefined,
        };
      } else {
        accountsConfig = { accounts: [] };
      }
    }
  } catch {
    accountsConfig = { accounts: [] };
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
 */
export function saveAccounts(config: AccountsConfig): void {
  // Ensure config directory exists with 0o700 permissions
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(CONFIG_PATH, { recursive: true, mode: 0o700 });
  }

  const accountsPath = path.join(CONFIG_PATH, 'accounts.json');
  fs.writeFileSync(accountsPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  // Update in-memory state
  accountsConfig = config;
}

/**
 * Remove an account by domain. Returns true if found and removed.
 */
export function removeAccount(domain: string): boolean {
  loadAccounts();

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
  loadAccounts();

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
