import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  type TokenData,
  type AccountInfo,
  type AccountsConfig,
  type ZendeskAccount,
  TOKEN_REFRESH_BUFFER_MS,
  REQUEST_TIMEOUT_MS,
  assertValidSubdomain,
} from './types.js';

export const CONFIG_PATH = process.env.ZENDESK_CONFIG_PATH || path.join(os.homedir(), '.mcp', 'zendesk');
export const BRIDGE_STATE_PATH = process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE;

const ZENDESK_CLIENT_ID = process.env.ZENDESK_CLIENT_ID;
const ZENDESK_CLIENT_SECRET = process.env.ZENDESK_CLIENT_SECRET;

let accountsConfig: AccountsConfig = { accounts: [] };
let accounts: Map<string, ZendeskAccount> = new Map();

export function getAccountsConfig(): AccountsConfig {
  return accountsConfig;
}

export function loadAccounts(): void {
  const accountsPath = path.join(CONFIG_PATH, 'accounts.json');
  const credentialsDir = path.join(CONFIG_PATH, 'credentials');

  try {
    if (fs.existsSync(accountsPath)) {
      const raw = fs.readFileSync(accountsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.accounts)) {
        accountsConfig = {
          accounts: parsed.accounts,
          defaultSubdomain: typeof parsed.defaultSubdomain === 'string' ? parsed.defaultSubdomain : undefined,
        };
      } else {
        accountsConfig = { accounts: [] };
      }
    }
  } catch {
    accountsConfig = { accounts: [] };
  }

  accounts.clear();

  try {
    if (fs.existsSync(credentialsDir)) {
      const files = fs.readdirSync(credentialsDir);
      for (const file of files) {
        if (file.endsWith('.token.json')) {
          const subdomain = file.replace('.token.json', '');
          const tokenPath = path.join(credentialsDir, file);
          try {
            assertValidSubdomain(subdomain);
            const tokenRaw = fs.readFileSync(tokenPath, 'utf8');
            const tokenData: TokenData = JSON.parse(tokenRaw);

            accounts.set(subdomain, {
              subdomain,
              email: tokenData.email,
              authType: 'oauth',
              accessToken: tokenData.access_token,
              refreshToken: tokenData.refresh_token,
              expiresAt: tokenData.expires_at,
            });

            const existingAccount = accountsConfig.accounts.find(a => a.subdomain === subdomain);
            if (!existingAccount && tokenData.email) {
              accountsConfig.accounts.push({ subdomain, email: tokenData.email });
              if (!accountsConfig.defaultSubdomain) {
                accountsConfig.defaultSubdomain = subdomain;
              }
            }
          } catch (tokenError) {
            console.error(`[Zendesk] Failed to load token for ${subdomain}:`, tokenError);
          }
        }
      }
    }
  } catch (dirError) {
    console.error('[Zendesk] Failed to read credentials directory:', dirError);
  }

  for (const account of accountsConfig.accounts) {
    try {
      assertValidSubdomain(account.subdomain);
      if (account.apiToken && !accounts.has(account.subdomain)) {
        accounts.set(account.subdomain, {
          subdomain: account.subdomain,
          email: account.email,
          apiToken: account.apiToken,
          authType: 'api-token',
          accessToken: '',
          expiresAt: Infinity,
        });
      }
    } catch (error) {
      console.error('[Zendesk] Failed to load account:', error);
    }
  }
}

export function saveToken(subdomain: string, tokenData: TokenData): void {
  const credentialsDir = path.join(CONFIG_PATH, 'credentials');
  try {
    if (!fs.existsSync(credentialsDir)) {
      fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    }
    const tokenPath = path.join(credentialsDir, `${subdomain}.token.json`);
    fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error(`[Zendesk] Failed to save token for ${subdomain}:`, error);
  }
}

export async function refreshToken(subdomain: string): Promise<boolean> {
  assertValidSubdomain(subdomain);
  const account = accounts.get(subdomain);
  if (!account || !account.refreshToken) {
    console.error(`[Zendesk] Cannot refresh token for ${subdomain}: no refresh token available`);
    return false;
  }

  if (!ZENDESK_CLIENT_ID || !ZENDESK_CLIENT_SECRET) {
    console.error('[Zendesk] Cannot refresh token: missing ZENDESK_CLIENT_ID or ZENDESK_CLIENT_SECRET');
    return false;
  }

  try {
    const tokenUrl = `https://${subdomain}.zendesk.com/oauth/tokens`;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ZENDESK_CLIENT_ID,
      client_secret: ZENDESK_CLIENT_SECRET,
      refresh_token: account.refreshToken,
      scope: 'read write',
    });
    const response = await fetch(tokenUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      // Do not read or log the raw vendor error body — it is
      // attacker/vendor-controlled and may contain echoed request data.
      console.error(`[Zendesk] Token refresh failed for ${subdomain} (HTTP ${response.status})`);
      return false;
    }

    let tokenResponse: {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };
    try {
      tokenResponse = await response.json();
    } catch {
      // The runtime JSON parse error can embed a fragment of the response
      // body; do not let it reach logs.
      console.error(`[Zendesk] Token refresh for ${subdomain} returned an unparseable response`);
      return false;
    }

    const expiresAt = Date.now() + (tokenResponse.expires_in * 1000);
    account.accessToken = tokenResponse.access_token;
    if (tokenResponse.refresh_token) {
      account.refreshToken = tokenResponse.refresh_token;
    }
    account.expiresAt = expiresAt;

    const tokenData: TokenData = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token || account.refreshToken,
      expires_in: tokenResponse.expires_in,
      expires_at: expiresAt,
      token_type: tokenResponse.token_type,
      subdomain,
      email: account.email,
    };
    saveToken(subdomain, tokenData);

    console.error(`[Zendesk] Token refreshed for ${subdomain}, expires in ${tokenResponse.expires_in}s`);
    return true;
  } catch (error) {
    console.error(`[Zendesk] Token refresh error for ${subdomain}:`, error);
    return false;
  }
}

export function getAuthHeader(account: ZendeskAccount): string {
  if (account.authType === 'api-token' && account.apiToken) {
    return `Basic ${Buffer.from(`${account.email}/token:${account.apiToken}`).toString('base64')}`;
  }
  return `Bearer ${account.accessToken}`;
}

function tokenNeedsRefresh(account: ZendeskAccount): boolean {
  if (account.authType === 'api-token') return false;
  const now = Date.now();
  return account.expiresAt <= now + TOKEN_REFRESH_BUFFER_MS;
}

export function getTokenStatus(account: ZendeskAccount): 'active' | 'expired' | 'needs-refresh' {
  if (account.authType === 'api-token') return 'active';
  const now = Date.now();
  if (account.expiresAt <= now) return 'expired';
  if (account.expiresAt <= now + TOKEN_REFRESH_BUFFER_MS) return 'needs-refresh';
  return 'active';
}

export async function getAccount(subdomain?: string): Promise<ZendeskAccount | undefined> {
  loadAccounts();
  if (accounts.size === 0) return undefined;

  let account: ZendeskAccount | undefined;
  if (subdomain) {
    account = accounts.get(subdomain);
  } else {
    const defaultSub = accountsConfig.defaultSubdomain;
    if (defaultSub) {
      account = accounts.get(defaultSub);
    }
    if (!account) {
      account = accounts.values().next().value;
    }
  }

  if (!account) return undefined;

  if (tokenNeedsRefresh(account)) {
    console.error(`[Zendesk] Token for ${account.subdomain} needs refresh (expires at ${new Date(account.expiresAt).toISOString()})`);
    const refreshed = await refreshToken(account.subdomain);
    if (!refreshed) {
      console.error(`[Zendesk] Token refresh failed for ${account.subdomain}`);
    }
  }

  return account;
}

export function removeAccount(subdomain: string): void {
  const idx = accountsConfig.accounts.findIndex(a => a.subdomain === subdomain);
  if (idx >= 0) {
    accountsConfig.accounts.splice(idx, 1);
  }
  if (accountsConfig.defaultSubdomain === subdomain) {
    accountsConfig.defaultSubdomain = accountsConfig.accounts[0]?.subdomain;
  }
  try {
    const accountsPath = path.join(CONFIG_PATH, 'accounts.json');
    fs.writeFileSync(accountsPath, JSON.stringify(accountsConfig, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('[Zendesk] Failed to save accounts:', error);
  }
  const tokenPath = path.join(CONFIG_PATH, 'credentials', `${subdomain}.token.json`);
  try {
    if (fs.existsSync(tokenPath)) {
      fs.unlinkSync(tokenPath);
    }
  } catch (error) {
    console.error(`[Zendesk] Failed to remove token file for ${subdomain}:`, error);
  }
  accounts.delete(subdomain);
}

// Initialize accounts on module load
loadAccounts();
