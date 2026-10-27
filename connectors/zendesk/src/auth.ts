import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'crypto';
import {
  type TokenData,
  type AccountInfo,
  type AccountsConfig,
  type ZendeskAccount,
  type AuthIssue,
  type RefreshResult,
  TOKEN_REFRESH_BUFFER_MS,
  REQUEST_TIMEOUT_MS,
  assertValidSubdomain,
} from './types.js';

export const CONFIG_PATH = process.env.ZENDESK_CONFIG_PATH || path.join(os.homedir(), '.mcp', 'zendesk');
export const BRIDGE_STATE_PATH = process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE;

/** The largest valid Date, used for a token the server gave no lifetime. */
const NON_EXPIRING_MS = 8_640_000_000_000_000;

/** Token-endpoint error codes that mean the stored sign-in can't be renewed. */
const RECONNECT_ERROR_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

let accountsConfig: AccountsConfig = { accounts: [] };
let accounts: Map<string, ZendeskAccount> = new Map();

/** One refresh per subdomain at a time: refresh tokens are single-use. */
const refreshesInFlight = new Map<string, Promise<RefreshResult>>();

/**
 * Refresh tokens the server has refused, per subdomain. Kept in memory so a
 * dead token is never spent twice in one process; a new sign-in writes a
 * different refresh token, which clears the mark.
 */
const deadRefreshTokens = new Map<string, string>();

/** The token fields a refresh renews. */
type RenewedFields = Pick<TokenData, 'access_token' | 'refresh_token' | 'expires_in' | 'expires_at' | 'token_type'>;

/**
 * Renewals that couldn't be saved, per subdomain. The file still holds
 * `diskRefreshToken`, which the server has already rotated away, so the
 * renewed fields stand in for the file's until the file changes. Without
 * this, the next load would spend that refresh token a second time.
 */
const unsavedRenewals = new Map<string, { diskRefreshToken: unknown; fields: RenewedFields }>();

function withUnsavedRenewal(subdomain: string, fileData: Record<string, unknown>): Record<string, unknown> {
  const unsaved = unsavedRenewals.get(subdomain);
  if (!unsaved) return fileData;
  if (fileData.refresh_token !== unsaved.diskRefreshToken) {
    // Saved since, signed in again, or changed by someone else: the file wins.
    unsavedRenewals.delete(subdomain);
    return fileData;
  }
  return { ...fileData, ...unsaved.fields };
}

/** True while this account runs on a renewed sign-in that couldn't be saved. */
export function hasUnsavedRenewal(subdomain: string): boolean {
  return unsavedRenewals.has(subdomain);
}

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
            const tokenData = withUnsavedRenewal(subdomain, JSON.parse(tokenRaw)) as unknown as TokenData;

            let authIssue: AuthIssue | undefined;
            const deadToken = deadRefreshTokens.get(subdomain);
            if (deadToken !== undefined) {
              if (tokenData.refresh_token === deadToken) {
                authIssue = 'reconnect';
              } else {
                deadRefreshTokens.delete(subdomain);
              }
            }

            accounts.set(subdomain, {
              subdomain,
              email: tokenData.email,
              authType: 'oauth',
              accessToken: tokenData.access_token,
              refreshToken: tokenData.refresh_token,
              expiresAt: tokenData.expires_at,
              ...(authIssue ? { authIssue } : {}),
            });

            const existingAccount = accountsConfig.accounts.find(a => a.subdomain === subdomain);
            if (!existingAccount && tokenData.email) {
              accountsConfig.accounts.push({ subdomain, email: tokenData.email });
              if (!accountsConfig.defaultSubdomain) {
                accountsConfig.defaultSubdomain = subdomain;
              }
            }
          } catch (tokenError) {
            // A JSON parse error can quote part of the file, which holds tokens.
            const reason = tokenError instanceof SyntaxError
              ? 'the file is not valid JSON'
              : tokenError instanceof Error ? tokenError.message : 'unknown error';
            console.error(`[Zendesk] Failed to load token for ${subdomain}: ${reason}`);
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

function tokenFilePath(subdomain: string): string {
  return path.join(CONFIG_PATH, 'credentials', `${subdomain}.token.json`);
}

function errorName(error: unknown): string {
  if (error && typeof error === 'object') {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === 'string') return code;
    if (typeof name === 'string') return name;
  }
  return 'unknown error';
}

/**
 * Write `text` to `target` through a temp file in the same folder and a
 * rename, so a reader never sees a partial file. `canReplace` runs just
 * before the rename; if it returns false, nothing is written and this
 * returns false.
 */
function writeFileAtomic(target: string, text: string, canReplace?: () => boolean): boolean {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (canReplace && !canReplace()) {
      fs.unlinkSync(tmp);
      return false;
    }
    fs.renameSync(tmp, target);
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

export function saveToken(subdomain: string, tokenData: TokenData): void {
  const credentialsDir = path.join(CONFIG_PATH, 'credentials');
  try {
    if (!fs.existsSync(credentialsDir)) {
      fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    }
    writeFileAtomic(tokenFilePath(subdomain), JSON.stringify(tokenData, null, 2));
  } catch (error) {
    console.error(`[Zendesk] Failed to save token for ${subdomain} (${errorName(error)})`);
  }
}

type ReplaceOutcome =
  | { status: 'written' | 'absent' | 'failed' }
  | { status: 'changed'; latest: Record<string, unknown> | null };

/**
 * Replace a token file only if it still holds `expectedRefreshToken`, the
 * one this refresh read. Doesn't create one: if the file is gone, a
 * Disconnect removed it while the refresh was running, and the sign-in must
 * stay removed. If it holds anything else (a new sign-in, another writer),
 * that wins and is returned as `changed`. The check and the rename are
 * separate steps, so a change in the microseconds between them can still be
 * overwritten; there are no lock files, by design.
 */
function replaceTokenFileAtomic(
  subdomain: string,
  expectedRefreshToken: unknown,
  data: Record<string, unknown>,
): ReplaceOutcome {
  const target = tokenFilePath(subdomain);
  const check: { blocked?: ReplaceOutcome } = {};
  try {
    const written = writeFileAtomic(target, JSON.stringify(data, null, 2), () => {
      if (!fs.existsSync(target)) {
        check.blocked = { status: 'absent' };
        return false;
      }
      const latest = readTokenFile(subdomain);
      if (!latest || latest.refresh_token !== expectedRefreshToken) {
        check.blocked = { status: 'changed', latest };
        return false;
      }
      return true;
    });
    return written ? { status: 'written' } : check.blocked ?? { status: 'absent' };
  } catch (error) {
    console.error(`[Zendesk] Failed to save the renewed token for ${subdomain} (${errorName(error)})`);
    return { status: 'failed' };
  }
}

function readTokenFile(subdomain: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(tokenFilePath(subdomain), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Read only the OAuth `error` code from a failed token response; never the rest of the body. */
async function readOAuthErrorCode(response: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = await response.json();
    const code = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/** For logs: a vendor-supplied code is shown only if it looks like an OAuth error code. */
function loggableCode(code: string | undefined): string {
  return code && /^[a-z_]{1,64}$/.test(code) ? `, ${code}` : '';
}

/**
 * Renew an OAuth sign-in with its refresh token, as a public client: the
 * client id comes from the token file (the client that issued the token),
 * else ZENDESK_CLIENT_ID. Concurrent callers for one subdomain share a single
 * request. Callers apply a successful result to their own account object.
 */
export async function refreshToken(subdomain: string): Promise<RefreshResult> {
  assertValidSubdomain(subdomain);
  const pending = refreshesInFlight.get(subdomain);
  if (pending) return pending;
  const flight = runRefresh(subdomain).finally(() => {
    refreshesInFlight.delete(subdomain);
  });
  refreshesInFlight.set(subdomain, flight);
  return flight;
}

async function runRefresh(subdomain: string): Promise<RefreshResult> {
  const reconnect: RefreshResult = { ok: false, reason: 'reconnect' };
  const transient: RefreshResult = { ok: false, reason: 'transient' };
  const memory = accounts.get(subdomain);
  const fileData = readTokenFile(subdomain);

  if (!fileData) {
    console.error(`[Zendesk] Cannot refresh token for ${subdomain}: no stored sign-in`);
    return reconnect;
  }
  const onDisk = withUnsavedRenewal(subdomain, fileData);

  // Another process may have renewed the token since this one read it.
  const diskAccess = nonEmptyString(onDisk.access_token);
  const diskRefresh = nonEmptyString(onDisk.refresh_token);
  const diskExpiresAt = typeof onDisk.expires_at === 'number' ? onDisk.expires_at : NaN;
  if (diskAccess && diskRefresh && diskRefresh !== memory?.refreshToken
    && diskExpiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    if (memory) {
      memory.accessToken = diskAccess;
      memory.refreshToken = diskRefresh;
      memory.expiresAt = diskExpiresAt;
      delete memory.authIssue;
    }
    console.error(`[Zendesk] Using the token renewed elsewhere for ${subdomain}`);
    return { ok: true, accessToken: diskAccess, expiresAt: diskExpiresAt };
  }

  const refreshTokenToSpend = diskRefresh ?? memory?.refreshToken;
  if (!refreshTokenToSpend) {
    console.error(`[Zendesk] Cannot refresh token for ${subdomain}: no refresh token available`);
    return reconnect;
  }
  if (deadRefreshTokens.get(subdomain) === refreshTokenToSpend) {
    return reconnect;
  }

  const fileClientId = nonEmptyString(onDisk.client_id);
  const clientId = fileClientId ?? nonEmptyString(process.env.ZENDESK_CLIENT_ID);
  if (!clientId) {
    console.error(`[Zendesk] Cannot refresh token for ${subdomain}: no OAuth client id in the token file or ZENDESK_CLIENT_ID`);
    return { ok: false, reason: 'no_client_id' };
  }

  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshTokenToSpend,
    client_id: clientId,
  };
  // Only a legacy confidential client configured through the env has a secret.
  const envSecret = fileClientId ? undefined : nonEmptyString(process.env.ZENDESK_CLIENT_SECRET);
  if (envSecret) body.client_secret = envSecret;
  const scope = nonEmptyString(onDisk.scope);
  if (scope) body.scope = scope;

  let response: Response;
  try {
    response = await fetch(`https://${subdomain}.zendesk.com/oauth/tokens`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error(`[Zendesk] Token refresh for ${subdomain} could not reach Zendesk (${errorName(error)})`);
    return transient;
  }

  if (!response.ok) {
    // Only the `error` code is read: the rest of the body (including
    // error_description) is vendor-controlled and may echo request data.
    const code = await readOAuthErrorCode(response);
    if ((response.status === 400 || response.status === 401) && code && RECONNECT_ERROR_CODES.has(code)) {
      deadRefreshTokens.set(subdomain, refreshTokenToSpend);
      if (memory) memory.authIssue = 'reconnect';
      console.error(`[Zendesk] Token refresh for ${subdomain} was refused (HTTP ${response.status}${loggableCode(code)}); the account needs to sign in again`);
      return reconnect;
    }
    console.error(`[Zendesk] Token refresh failed for ${subdomain} (HTTP ${response.status}${loggableCode(code)})`);
    return transient;
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    // The runtime JSON parse error can embed a fragment of the response
    // body; do not let it reach logs.
    console.error(`[Zendesk] Token refresh for ${subdomain} returned an unparseable response`);
    return transient;
  }
  const tokenResponse = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const accessToken = nonEmptyString(tokenResponse.access_token);
  if (!accessToken) {
    console.error(`[Zendesk] Token refresh for ${subdomain} returned no access token`);
    return transient;
  }

  const expiresIn = typeof tokenResponse.expires_in === 'number' && Number.isFinite(tokenResponse.expires_in)
    && tokenResponse.expires_in > 0 ? tokenResponse.expires_in : undefined;
  const expiresAt = expiresIn !== undefined ? Date.now() + expiresIn * 1000 : NON_EXPIRING_MS;
  const newRefreshToken = nonEmptyString(tokenResponse.refresh_token) ?? refreshTokenToSpend;
  const tokenType = nonEmptyString(tokenResponse.token_type) ?? nonEmptyString(onDisk.token_type) ?? 'bearer';

  const renewed: RenewedFields = {
    access_token: accessToken,
    refresh_token: newRefreshToken,
    expires_in: expiresIn ?? 0,
    expires_at: expiresAt,
    token_type: tokenType,
  };
  // Keep client_id, scope, email, subdomain and any other stored fields.
  const outcome = replaceTokenFileAtomic(subdomain, fileData.refresh_token, { ...onDisk, ...renewed });
  const current = accounts.get(subdomain);
  if (outcome.status === 'failed') {
    unsavedRenewals.set(subdomain, { diskRefreshToken: fileData.refresh_token, fields: renewed });
    console.error(`[Zendesk] The renewed token for ${subdomain} works for now, but you may need to reconnect after a restart`);
  } else {
    unsavedRenewals.delete(subdomain);
  }
  if (outcome.status === 'absent') {
    console.error(`[Zendesk] The sign-in for ${subdomain} was removed during a token refresh; not saving the renewed token`);
  } else if (outcome.status === 'changed') {
    // A new sign-in (or another writer) replaced the file while this refresh
    // ran. Its tokens are newer than the ones just received: use them.
    console.error(`[Zendesk] The sign-in for ${subdomain} changed during a token refresh; using the new one`);
    const latestAccess = nonEmptyString(outcome.latest?.access_token);
    if (!latestAccess) return reconnect;
    const latestExpiresAt = typeof outcome.latest?.expires_at === 'number' ? outcome.latest.expires_at : NaN;
    if (!(latestExpiresAt > Date.now())) return transient;
    if (current) {
      current.accessToken = latestAccess;
      current.refreshToken = nonEmptyString(outcome.latest?.refresh_token);
      current.expiresAt = latestExpiresAt;
      delete current.authIssue;
    }
    return { ok: true, accessToken: latestAccess, expiresAt: latestExpiresAt };
  }

  if (current) {
    current.accessToken = accessToken;
    current.refreshToken = newRefreshToken;
    current.expiresAt = expiresAt;
    delete current.authIssue;
  }

  console.error(`[Zendesk] Token refreshed for ${subdomain}${expiresIn !== undefined ? `, expires in ${expiresIn}s` : ''}`);
  return { ok: true, accessToken, expiresAt };
}

export function getAuthHeader(account: ZendeskAccount): string {
  if (account.authType === 'api-token' && account.apiToken) {
    return `Basic ${Buffer.from(`${account.email}/token:${account.apiToken}`).toString('base64')}`;
  }
  return `Bearer ${account.accessToken}`;
}

/** ISO time for an expiry, or undefined when it isn't a representable date. */
export function formatExpiry(expiresAt: number): string | undefined {
  return Number.isFinite(expiresAt) && Math.abs(expiresAt) <= NON_EXPIRING_MS
    ? new Date(expiresAt).toISOString()
    : undefined;
}

function tokenNeedsRefresh(account: ZendeskAccount): boolean {
  if (account.authType === 'api-token') return false;
  const now = Date.now();
  return account.expiresAt <= now + TOKEN_REFRESH_BUFFER_MS;
}

export function getTokenStatus(account: ZendeskAccount): 'active' | 'expired' | 'needs-refresh' | 'reconnect-required' {
  if (account.authType === 'api-token') return 'active';
  if (account.authIssue === 'reconnect' || account.authIssue === 'no_client_id') return 'reconnect-required';
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

  if (!account.authIssue && tokenNeedsRefresh(account)) {
    console.error(`[Zendesk] Token for ${account.subdomain} needs refresh (expires at ${formatExpiry(account.expiresAt) ?? 'an unknown time'})`);
    // `account` is this call's own object (loadAccounts rebuilds the map), so
    // the result is applied to it directly.
    const result = await refreshToken(account.subdomain);
    if (result.ok) {
      account.accessToken = result.accessToken;
      account.expiresAt = result.expiresAt;
      delete account.authIssue;
    } else if (result.reason !== 'transient') {
      account.authIssue = result.reason;
    } else if (account.expiresAt <= Date.now()) {
      // Inside the refresh buffer the current token still works; once it
      // has expired, fail the call instead of sending it.
      account.authIssue = 'transient';
    }
  }

  return account;
}

export function removeAccount(subdomain: string): void {
  // The subdomain is joined into a credentials file path and unlinked below,
  // so validate it like every other subdomain sink BEFORE any mutation: a
  // traversal value (e.g. "../../slack/credentials/team") must never reach
  // writeFileSync/unlinkSync, where it would delete another connector's
  // stored credentials outside the Zendesk config root.
  assertValidSubdomain(subdomain);
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
