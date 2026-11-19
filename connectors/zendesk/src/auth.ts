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
  SUBDOMAIN_RE,
} from './types.js';

export const CONFIG_PATH = process.env.ZENDESK_CONFIG_PATH || path.join(os.homedir(), '.mcp', 'zendesk');

/** The largest valid Date, used for a token the server gave no lifetime. */
const NON_EXPIRING_MS = 8_640_000_000_000_000;

/** accounts.json and token files are a few KiB; anything past this is refused. */
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

/** Token-endpoint error codes that mean the stored sign-in can't be renewed. */
const RECONNECT_ERROR_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

let accountsConfig: AccountsConfig = { accounts: [] };

/**
 * True while the last load could not read accounts.json (refused, too large,
 * not valid JSON, ...). The in-memory list is then empty, not the file's, so
 * saving it would wipe the file; saves are skipped until a load succeeds or
 * finds the file absent.
 */
let accountsFileUnreadable = false;
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

  let accountsRaw: string | undefined;
  try {
    accountsRaw = readConfigFile(accountsPath);
    accountsFileUnreadable = false;
  } catch (error) {
    accountsFileUnreadable = errorName(error) !== 'ENOENT';
    // A missing file means no accounts saved yet. Anything else (a symlink,
    // not a regular file, too large) is refused; the error's message names
    // the config path, so log its code only.
    if (errorName(error) !== 'ENOENT') {
      console.error(`[Zendesk] Failed to read the accounts file (${errorName(error)})`);
      accountsConfig = { accounts: [] };
    }
  }
  if (accountsRaw !== undefined) {
    try {
      const parsed = JSON.parse(accountsRaw);
      if (parsed && Array.isArray(parsed.accounts)) {
        accountsConfig = {
          accounts: parsed.accounts,
          defaultSubdomain: typeof parsed.defaultSubdomain === 'string' ? parsed.defaultSubdomain : undefined,
        };
      } else {
        accountsConfig = { accounts: [] };
      }
    } catch {
      // A JSON parse error can quote part of the file, which holds API tokens.
      console.error('[Zendesk] Failed to read the accounts file (the file is not valid JSON)');
      accountsConfig = { accounts: [] };
      accountsFileUnreadable = true;
    }
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
            const tokenRaw = readConfigFile(tokenPath);
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
            // A JSON parse error can quote part of the file, which holds
            // tokens, and other messages name the file, which names the
            // tenant: log only a fixed reason or the error code.
            const reason = tokenError instanceof SyntaxError
              ? 'the file is not valid JSON'
              : SUBDOMAIN_RE.test(subdomain) ? errorName(tokenError) : 'the file name is not a valid subdomain';
            console.error(`[Zendesk] Failed to load a stored sign-in: ${reason}`);
          }
        }
      }
    }
  } catch (dirError) {
    // The error's message holds the config path, so log its code only.
    console.error(`[Zendesk] Failed to read the credentials directory (${errorName(dirError)})`);
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
      // The error can quote the invalid subdomain, and the row may not be an
      // object at all: log only the error's code or name.
      console.error(`[Zendesk] Skipped an account (${errorName(error)})`);
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
 * Read a credential file (accounts.json, a token file) without following a
 * symlink at its final component: an lstat refusal, then `O_NOFOLLOW` on the
 * open where the platform defines it, `O_NONBLOCK` so a FIFO is refused
 * rather than waited on, a same-descriptor check that it is a regular file,
 * and a read through that descriptor of at most MAX_CONFIG_FILE_BYTES.
 * Symlinked folders above the file stay allowed. Throws an error with a
 * `code` (ENOENT when missing, ELOOP for a symlink) and never logs: callers
 * log the code, never the message, which names the path.
 */
function readConfigFile(filePath: string): string {
  if (fs.lstatSync(filePath).isSymbolicLink()) {
    throw Object.assign(new Error('refusing to read through a symbolic link'), { code: 'ELOOP' });
  }
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw Object.assign(new Error('not a regular file'), { code: 'ENOTREGULAR' });
    }
    const buffer = Buffer.alloc(MAX_CONFIG_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_CONFIG_FILE_BYTES) {
      throw Object.assign(new Error('file is too large'), { code: 'EFBIG' });
    }
    return buffer.toString('utf8', 0, length);
  } finally {
    try { fs.closeSync(fd); } catch { /* a read-only descriptor: nothing to lose */ }
  }
}

/**
 * Write `text` to `target` through a temp file in the same folder and a
 * rename, so a reader never sees a partial file. `canReplace` runs just
 * before the rename; if it returns false, nothing is written and this
 * returns false. A symlink at `target`, even a dangling one, is refused
 * (ELOOP) rather than replaced.
 */
function writeFileAtomic(target: string, text: string, canReplace?: () => boolean): boolean {
  // lstat, not existsSync: existsSync is false for a dangling link.
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(target);
  } catch (error) {
    if (errorName(error) !== 'ENOENT') throw error;
  }
  if (existing?.isSymbolicLink()) {
    throw Object.assign(new Error('refusing to replace a symbolic link'), { code: 'ELOOP' });
  }
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    // writeSync may write fewer bytes than asked (a full or busy disk), so
    // loop until all of it is written; no progress at all fails the save.
    const data = Buffer.from(text, 'utf8');
    for (let offset = 0; offset < data.length;) {
      const written = fs.writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) throw Object.assign(new Error('short write'), { code: 'ESHORTWRITE' });
      offset += written;
    }
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
    console.error(`[Zendesk] Failed to save the sign-in for the Zendesk account (${errorName(error)})`);
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
    console.error(`[Zendesk] Failed to save the renewed token for the Zendesk account (${errorName(error)})`);
    return { status: 'failed' };
  }
}

function readTokenFile(subdomain: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readConfigFile(tokenFilePath(subdomain)));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch (error) {
    // A missing token is normal (never signed in, or disconnected). Otherwise
    // log only the code or name: a parse error can quote tokens, and other
    // messages name the file, which names the tenant.
    if (errorName(error) !== 'ENOENT') {
      console.error(`[Zendesk] Failed to read a stored sign-in (${errorName(error)})`);
    }
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
    console.error('[Zendesk] Cannot refresh the token for the Zendesk account: no stored sign-in');
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
    console.error('[Zendesk] Using the token renewed elsewhere for the Zendesk account');
    return { ok: true, accessToken: diskAccess, expiresAt: diskExpiresAt };
  }

  const refreshTokenToSpend = diskRefresh ?? memory?.refreshToken;
  if (!refreshTokenToSpend) {
    console.error('[Zendesk] Cannot refresh the token for the Zendesk account: no refresh token available');
    return reconnect;
  }
  if (deadRefreshTokens.get(subdomain) === refreshTokenToSpend) {
    return reconnect;
  }

  const fileClientId = nonEmptyString(onDisk.client_id);
  const clientId = fileClientId ?? nonEmptyString(process.env.ZENDESK_CLIENT_ID);
  if (!clientId) {
    console.error('[Zendesk] Cannot refresh the token for the Zendesk account: no OAuth client id in the token file or ZENDESK_CLIENT_ID');
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
    console.error(`[Zendesk] Token refresh for the Zendesk account could not reach Zendesk (${errorName(error)})`);
    return transient;
  }

  if (!response.ok) {
    // Only the `error` code is read: the rest of the body (including
    // error_description) is vendor-controlled and may echo request data.
    const code = await readOAuthErrorCode(response);
    if ((response.status === 400 || response.status === 401) && code && RECONNECT_ERROR_CODES.has(code)) {
      deadRefreshTokens.set(subdomain, refreshTokenToSpend);
      if (memory) memory.authIssue = 'reconnect';
      console.error(`[Zendesk] Token refresh for the Zendesk account was refused (HTTP ${response.status}${loggableCode(code)}); the account needs to sign in again`);
      return reconnect;
    }
    console.error(`[Zendesk] Token refresh failed for the Zendesk account (HTTP ${response.status}${loggableCode(code)})`);
    return transient;
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    // The runtime JSON parse error can embed a fragment of the response
    // body; do not let it reach logs.
    console.error('[Zendesk] Token refresh for the Zendesk account returned an unparseable response');
    return transient;
  }
  const tokenResponse = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const accessToken = nonEmptyString(tokenResponse.access_token);
  if (!accessToken) {
    console.error('[Zendesk] Token refresh for the Zendesk account returned no access token');
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
    console.error('[Zendesk] The renewed token for the Zendesk account works for now, but you may need to reconnect after a restart');
  } else {
    unsavedRenewals.delete(subdomain);
  }
  if (outcome.status === 'absent') {
    console.error('[Zendesk] The sign-in for the Zendesk account was removed during a token refresh; not saving the renewed token');
  } else if (outcome.status === 'changed') {
    // A new sign-in (or another writer) replaced the file while this refresh
    // ran. Its tokens are newer than the ones just received: use them.
    console.error('[Zendesk] The sign-in for the Zendesk account changed during a token refresh; using the new one');
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

  console.error(`[Zendesk] Token refreshed for the Zendesk account${expiresIn !== undefined ? `, expires in ${expiresIn}s` : ''}`);
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
    console.error(`[Zendesk] Token for the Zendesk account needs refresh (expires at ${formatExpiry(account.expiresAt) ?? 'an unknown time'})`);
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
  // writeFileAtomic/unlinkSync, where it would delete another connector's
  // stored credentials outside the Zendesk config root.
  assertValidSubdomain(subdomain);
  const idx = accountsConfig.accounts.findIndex(a => a?.subdomain === subdomain);
  if (idx >= 0) {
    accountsConfig.accounts.splice(idx, 1);
  }
  if (accountsConfig.defaultSubdomain === subdomain) {
    accountsConfig.defaultSubdomain = accountsConfig.accounts[0]?.subdomain;
  }
  if (accountsFileUnreadable) {
    // The in-memory list isn't the file's contents; saving it would wipe the file.
    console.error('[Zendesk] Not saving the accounts list: the accounts file could not be read');
  } else {
    try {
      const accountsPath = path.join(CONFIG_PATH, 'accounts.json');
      // Atomic and owner-only; a symlink at accounts.json is refused, never written through.
      writeFileAtomic(accountsPath, JSON.stringify(accountsConfig, null, 2));
    } catch (error) {
      // The error's message and path name the config directory.
      console.error(`[Zendesk] Failed to save accounts (${errorName(error)})`);
    }
  }
  const tokenPath = path.join(CONFIG_PATH, 'credentials', `${subdomain}.token.json`);
  try {
    if (fs.existsSync(tokenPath)) {
      fs.unlinkSync(tokenPath);
    }
  } catch (error) {
    console.error(`[Zendesk] Failed to remove the stored sign-in (${errorName(error)})`);
  }
  accounts.delete(subdomain);
}

// Initialize accounts on module load
loadAccounts();
