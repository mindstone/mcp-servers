import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import {
  type AuthMode,
  type OutreachTokenData,
  type OutreachAccountsConfig,
  type OutreachAccount,
  ConnectorError,
  MAX_VENDOR_ERROR_CHARS,
  OUTREACH_OAUTH_URL,
  OUTREACH_AUTHORIZE_URL,
} from './types.js';
import { BRIDGE_STATE_PATH } from './bridge.js';
import { wrapUntrusted } from './untrusted-content.js';

/**
 * Default OAuth scope set requested when OUTREACH_OAUTH_SCOPES is not set.
 * Covers every tool the connector ships: sequenceStates.all is required by
 * enrollment (outreach_add/remove_prospect_from_sequence), the *.read scopes
 * by the read-only list/get tools, tasks.all by task create/complete.
 */
const DEFAULT_OAUTH_SCOPES =
  'prospects.all sequences.all sequenceStates.all sequenceSteps.read sequenceTemplates.read templates.read accounts.all users.read tasks.all mailings.read calls.read mailboxes.read';

// ---------------------------------------------------------------------------
// Auth Mode Detection (resolved ONCE at startup)
// ---------------------------------------------------------------------------

let resolvedMode: AuthMode | null = null;

/**
 * Detect and freeze auth mode. Called once at startup.
 * Precedence: bridge > standalone_oauth > manual_token > unconfigured.
 */
export function resolveAuthMode(): AuthMode {
  if (resolvedMode !== null) return resolvedMode;

  const hasBridge = !!BRIDGE_STATE_PATH;
  const hasClientId = !!process.env.OUTREACH_CLIENT_ID;
  const hasClientSecret = !!process.env.OUTREACH_CLIENT_SECRET;
  const hasManualToken = !!process.env.OUTREACH_ACCESS_TOKEN;

  if (hasBridge) {
    resolvedMode = 'bridge';
    if (hasClientId || hasManualToken) {
      console.error(
        '[Outreach MCP] WARNING: Bridge state detected alongside other auth env vars. Using bridge mode (highest precedence).',
      );
    }
  } else if (hasClientId && hasClientSecret) {
    resolvedMode = 'standalone_oauth';
  } else if (hasManualToken) {
    resolvedMode = 'manual_token';
  } else {
    resolvedMode = 'unconfigured';
  }

  console.error(`[Outreach MCP] Auth mode: ${resolvedMode}`);
  return resolvedMode;
}

/**
 * Get the current auth mode (must be resolved first).
 */
export function getAuthMode(): AuthMode {
  if (resolvedMode === null) return resolveAuthMode();
  return resolvedMode;
}

/**
 * Reset auth mode (for testing only).
 */
export function _resetAuthMode(): void {
  resolvedMode = null;
}

// ---------------------------------------------------------------------------
// Config Directory & Token Persistence
// ---------------------------------------------------------------------------

function getConfigDir(): string {
  return process.env.OUTREACH_CONFIG_DIR || path.join(os.homedir(), '.mcp', 'outreach');
}

function getCredentialsDir(): string {
  return path.join(getConfigDir(), 'credentials');
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function ensureDirectories(): void {
  const configDir = getConfigDir();
  const credDir = getCredentialsDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(credDir)) {
    fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
  }
}

function getAccountsPath(): string {
  return path.join(getConfigDir(), 'accounts.json');
}

function getTokenPath(accountId: string): string {
  return path.join(getCredentialsDir(), `${sanitizeFilename(accountId)}.token.json`);
}

/**
 * Atomic write: write to temp file then rename.
 */
function atomicWriteFile(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Account Management
// ---------------------------------------------------------------------------

export function loadAccounts(): OutreachAccountsConfig {
  ensureDirectories();
  try {
    const data = fs.readFileSync(getAccountsPath(), 'utf-8');
    return JSON.parse(data) as OutreachAccountsConfig;
  } catch {
    return { accounts: [] };
  }
}

export function saveAccounts(config: OutreachAccountsConfig): void {
  ensureDirectories();
  atomicWriteFile(getAccountsPath(), JSON.stringify(config, null, 2));
}

export function loadToken(accountId: string): OutreachTokenData | null {
  try {
    const data = fs.readFileSync(getTokenPath(accountId), 'utf-8');
    return JSON.parse(data) as OutreachTokenData;
  } catch {
    return null;
  }
}

export function saveToken(accountId: string, token: OutreachTokenData): void {
  ensureDirectories();
  atomicWriteFile(getTokenPath(accountId), JSON.stringify(token, null, 2));
}

export function deleteToken(accountId: string): void {
  try {
    fs.unlinkSync(getTokenPath(accountId));
  } catch {
    // Token file may not exist
  }
}

// ---------------------------------------------------------------------------
// Active Token Resolution
// ---------------------------------------------------------------------------

/**
 * Get the active access token for API calls.
 * In manual_token mode, returns the env var token.
 * In standalone_oauth/bridge mode, loads from disk and refreshes if needed.
 */
export function getActiveToken(): { accountId: string; token: OutreachTokenData } {
  const mode = getAuthMode();

  if (mode === 'manual_token') {
    const accessToken = process.env.OUTREACH_ACCESS_TOKEN || '';
    return {
      accountId: 'manual',
      token: {
        access_token: accessToken,
        refresh_token: '',
        expires_at: Number.MAX_SAFE_INTEGER,
        scope: '',
        created_at: Date.now(),
        username: 'manual-token',
      },
    };
  }

  if (mode === 'unconfigured') {
    throw new ConnectorError(
      'No Outreach authentication configured',
      'UNCONFIGURED',
      'Set up authentication: (1) Set OUTREACH_CLIENT_ID and OUTREACH_CLIENT_SECRET for OAuth, or (2) Set OUTREACH_ACCESS_TOKEN for manual token mode. See README for details.',
    );
  }

  const config = loadAccounts();
  if (config.accounts.length === 0) {
    throw new ConnectorError(
      'No Outreach accounts connected',
      'NO_ACCOUNT',
      'Call outreach_connect_account to connect your Outreach account.',
    );
  }

  const accountId = config.accounts[0].id;
  const token = loadToken(accountId);
  if (!token) {
    throw new ConnectorError(
      'Outreach credentials not found',
      'NO_CREDENTIALS',
      'Call outreach_connect_account to reconnect.',
    );
  }

  return { accountId, token };
}

/**
 * Refresh access token if expired or about to expire.
 */
export async function refreshTokenIfNeeded(
  accountId: string,
  token: OutreachTokenData,
): Promise<OutreachTokenData> {
  const bufferMs = 5 * 60 * 1000;
  if (token.expires_at > Date.now() + bufferMs) return token;

  const mode = getAuthMode();
  if (mode === 'manual_token') return token;

  const clientId = process.env.OUTREACH_CLIENT_ID;
  const clientSecret = process.env.OUTREACH_CLIENT_SECRET;
  if (!clientId || !clientSecret || !token.refresh_token) {
    throw new ConnectorError(
      'Cannot refresh token — missing credentials',
      'REFRESH_FAILED',
      'Call outreach_connect_account to reconnect.',
    );
  }

  console.error('[Outreach MCP] Refreshing access token...');
  const response = await fetch(OUTREACH_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 401 || errorText.includes('invalid_grant')) {
      throw new ConnectorError(
        'Outreach refresh token expired',
        'TOKEN_EXPIRED',
        'Call outreach_connect_account to reconnect. Outreach refresh tokens expire after 14 days.',
      );
    }
    throw new ConnectorError(
      `Token refresh failed: ${response.status}`,
      'REFRESH_FAILED',
      'Try calling outreach_connect_account to reconnect.',
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  const refreshed: OutreachTokenData = {
    access_token: data.access_token as string,
    refresh_token: (data.refresh_token as string) || token.refresh_token,
    expires_at: Date.now() + ((data.expires_in as number) || 7200) * 1000,
    scope: (data.scope as string) || token.scope,
    created_at: (data.created_at as number) || Date.now(),
    username: token.username,
  };
  saveToken(accountId, refreshed);
  console.error('[Outreach MCP] Token refreshed successfully');
  return refreshed;
}

// ---------------------------------------------------------------------------
// Standalone OAuth Flow (localhost callback server)
// ---------------------------------------------------------------------------

let authInProgress = false;

/**
 * Start standalone OAuth flow with a localhost callback server.
 * Returns account info on success.
 */
export async function startStandaloneOAuth(): Promise<{
  success: boolean;
  username?: string;
  error?: string;
}> {
  if (authInProgress) {
    return { success: false, error: 'Authentication already in progress. Please complete the current flow first.' };
  }

  const clientId = process.env.OUTREACH_CLIENT_ID;
  const clientSecret = process.env.OUTREACH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {
      success: false,
      error: 'OUTREACH_CLIENT_ID and OUTREACH_CLIENT_SECRET must be set for standalone OAuth.',
    };
  }

  authInProgress = true;

  try {
    const result = await runOAuthCallbackServer(clientId, clientSecret);
    return result;
  } finally {
    authInProgress = false;
  }
}

async function runOAuthCallbackServer(
  clientId: string,
  clientSecret: string,
): Promise<{ success: boolean; username?: string; error?: string }> {
  const state = crypto.randomBytes(32).toString('hex');
  const port = parseInt(process.env.OUTREACH_OAUTH_PORT || '0', 10);
  // Hard-coded loopback bind. We deliberately do NOT honour an env override
  // (previously `MCP_OAUTH_BIND_HOST`): an OAuth callback server holding a
  // short-lived authorization code is a privilege-bearing local service and
  // must never be exposed beyond loopback. (M3.3 — VAL-OUTREACH-001..004.)
  const bindHost = '127.0.0.1';
  const timeoutMs = 5 * 60 * 1000; // 5 minutes

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const url = new URL(req.url, `http://${bindHost}:${actualPort}`);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication failed</h2><p>You can close this window.</p></body></html>');
        cleanup();
        resolve({ success: false, error: `OAuth error: ${error}` });
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Invalid state parameter</h2><p>Please try again.</p></body></html>');
        cleanup();
        resolve({ success: false, error: 'OAuth state mismatch — possible CSRF attack.' });
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Missing authorization code</h2><p>Please try again.</p></body></html>');
        cleanup();
        resolve({ success: false, error: 'No authorization code received.' });
        return;
      }

      try {
        const redirectUri = `http://localhost:${actualPort}/callback`;
        const tokenResponse = await fetch(OUTREACH_OAUTH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code,
          }).toString(),
        });

        if (!tokenResponse.ok) {
          const errText = await tokenResponse.text();
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Token exchange failed</h2><p>You can close this window.</p></body></html>');
          cleanup();
          // The token-endpoint body is vendor-authored external text; bound
          // and envelope it before it reaches model context (invariant #6).
          const enveloped =
            wrapUntrusted(errText.slice(0, MAX_VENDOR_ERROR_CHARS), 'outreach:api-error') ??
            'Unknown error';
          resolve({ success: false, error: `Token exchange failed: ${enveloped}` });
          return;
        }

        const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
        const username = (tokenData.email as string) || `user-${Date.now()}`;
        const accountId = sanitizeFilename(username);

        const token: OutreachTokenData = {
          access_token: tokenData.access_token as string,
          refresh_token: tokenData.refresh_token as string,
          expires_at: Date.now() + ((tokenData.expires_in as number) || 7200) * 1000,
          scope: (tokenData.scope as string) || '',
          created_at: Date.now(),
          username,
        };

        saveToken(accountId, token);

        const config = loadAccounts();
        const existingIdx = config.accounts.findIndex((a) => a.id === accountId);
        const account: OutreachAccount = {
          id: accountId,
          username,
          connected_at: new Date().toISOString(),
        };
        if (existingIdx >= 0) {
          config.accounts[existingIdx] = account;
        } else {
          config.accounts.push(account);
        }
        saveAccounts(config);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication successful!</h2><p>You can close this window.</p></body></html>');
        cleanup();
        resolve({ success: true, username });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication error</h2><p>You can close this window.</p></body></html>');
        cleanup();
        resolve({
          success: false,
          error: `Token exchange error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    let actualPort = port;
    let timeoutHandle: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      server.close();
    };

    server.listen(port, bindHost, () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') {
        actualPort = addr.port;
      }

      const redirectUri = `http://localhost:${actualPort}/callback`;
      const scopes = process.env.OUTREACH_OAUTH_SCOPES || DEFAULT_OAUTH_SCOPES;
      const authorizeUrl =
        `${OUTREACH_AUTHORIZE_URL}?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: scopes,
          state,
        }).toString();

      console.error(`[Outreach MCP] Open this URL to authenticate:\n${authorizeUrl}`);
    });

    timeoutHandle = setTimeout(() => {
      cleanup();
      resolve({ success: false, error: 'OAuth flow timed out after 5 minutes.' });
    }, timeoutMs);

    server.on('error', (err) => {
      cleanup();
      resolve({ success: false, error: `OAuth server error: ${err.message}` });
    });
  });
}
