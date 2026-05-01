import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import {
  type AuthMode,
  type SalesforceTokenData,
  type SalesforceAccountsConfig,
  type SalesforceAccount,
  ConnectorError,
} from './types.js';
import { BRIDGE_STATE_PATH } from './bridge.js';

// ---------------------------------------------------------------------------
// Auth Mode Detection (resolved ONCE at startup)
// ---------------------------------------------------------------------------

let resolvedMode: AuthMode | null = null;

export function resolveAuthMode(): AuthMode {
  if (resolvedMode !== null) return resolvedMode;

  const hasBridge = !!BRIDGE_STATE_PATH;
  const hasClientId = !!process.env.SALESFORCE_CLIENT_ID;
  const hasClientSecret = !!process.env.SALESFORCE_CLIENT_SECRET;
  const hasManualToken = !!process.env.SALESFORCE_ACCESS_TOKEN;

  if (hasBridge) {
    resolvedMode = 'bridge';
    if (hasClientId || hasManualToken) {
      console.error(
        '[Salesforce MCP] WARNING: Bridge state detected alongside other auth env vars. Using bridge mode (highest precedence).',
      );
    }
  } else if (hasClientId && hasClientSecret) {
    resolvedMode = 'standalone_oauth';
  } else if (hasManualToken) {
    resolvedMode = 'manual_token';
  } else {
    resolvedMode = 'unconfigured';
  }

  console.error(`[Salesforce MCP] Auth mode: ${resolvedMode}`);
  return resolvedMode;
}

export function getAuthMode(): AuthMode {
  if (resolvedMode === null) return resolveAuthMode();
  return resolvedMode;
}

export function _resetAuthMode(): void {
  resolvedMode = null;
}

// ---------------------------------------------------------------------------
// Config Directory & Token Persistence
// ---------------------------------------------------------------------------

function getConfigDir(): string {
  return process.env.SALESFORCE_CONFIG_DIR || path.join(os.homedir(), '.mcp', 'salesforce');
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

export function loadAccounts(): SalesforceAccountsConfig {
  ensureDirectories();
  try {
    const data = fs.readFileSync(getAccountsPath(), 'utf-8');
    return JSON.parse(data) as SalesforceAccountsConfig;
  } catch {
    return { accounts: [] };
  }
}

export function saveAccounts(config: SalesforceAccountsConfig): void {
  ensureDirectories();
  atomicWriteFile(getAccountsPath(), JSON.stringify(config, null, 2));
}

export function loadToken(accountId: string): SalesforceTokenData | null {
  try {
    const data = fs.readFileSync(getTokenPath(accountId), 'utf-8');
    return JSON.parse(data) as SalesforceTokenData;
  } catch {
    return null;
  }
}

export function saveToken(accountId: string, token: SalesforceTokenData): void {
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

export function getActiveToken(): { accountId: string; token: SalesforceTokenData } {
  const mode = getAuthMode();

  if (mode === 'manual_token') {
    const accessToken = process.env.SALESFORCE_ACCESS_TOKEN || '';
    const instanceUrl = process.env.SALESFORCE_INSTANCE_URL || 'https://login.salesforce.com';
    return {
      accountId: 'manual',
      token: {
        access_token: accessToken,
        instance_url: instanceUrl,
        expires_at: Number.MAX_SAFE_INTEGER,
        username: 'manual-token',
      },
    };
  }

  if (mode === 'unconfigured') {
    throw new ConnectorError(
      'No Salesforce authentication configured',
      'UNCONFIGURED',
      'Set up authentication: (1) Set SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET for OAuth, or (2) Set SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL for manual token mode. See README for details.',
    );
  }

  const config = loadAccounts();
  if (config.accounts.length === 0) {
    throw new ConnectorError(
      'No Salesforce accounts connected',
      'NO_ACCOUNT',
      'Call salesforce_connect_account to connect your Salesforce account.',
    );
  }

  const accountId = config.accounts[0].id;
  const token = loadToken(accountId);
  if (!token) {
    throw new ConnectorError(
      'Salesforce credentials not found',
      'NO_CREDENTIALS',
      'Call salesforce_connect_account to reconnect.',
    );
  }

  return { accountId, token };
}

// ---------------------------------------------------------------------------
// Standalone OAuth Flow
// ---------------------------------------------------------------------------

let authInProgress = false;

export async function startStandaloneOAuth(): Promise<{
  success: boolean;
  username?: string;
  error?: string;
}> {
  if (authInProgress) {
    return { success: false, error: 'Authentication already in progress. Please complete the current flow first.' };
  }

  const clientId = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {
      success: false,
      error: 'SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET must be set for standalone OAuth.',
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
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const port = parseInt(process.env.SALESFORCE_OAUTH_PORT || '0', 10);
  // Hard-coded loopback bind. We deliberately do NOT honour an env override
  // (previously `MCP_OAUTH_BIND_HOST`): an OAuth callback server with a
  // short-lived auth code is a privilege-bearing local service and must
  // never be exposed beyond loopback. (M3.2 — VAL-SALESFORCE-017..019.)
  const bindHost = '127.0.0.1';
  const isSandbox = process.env.SALESFORCE_SANDBOX === 'true';
  const loginBase = isSandbox ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
  const timeoutMs = 5 * 60 * 1000;

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
        const tokenResponse = await fetch(`${loginBase}/services/oauth2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code,
            code_verifier: codeVerifier,
          }).toString(),
        });

        if (!tokenResponse.ok) {
          const errText = await tokenResponse.text();
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Token exchange failed</h2><p>You can close this window.</p></body></html>');
          cleanup();
          resolve({ success: false, error: `Token exchange failed: ${errText}` });
          return;
        }

        const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
        const username = (tokenData.id as string)?.split('/').pop() || `user-${Date.now()}`;
        const accountId = sanitizeFilename(username);
        const instanceUrl = tokenData.instance_url as string;

        const token: SalesforceTokenData = {
          access_token: tokenData.access_token as string,
          refresh_token: tokenData.refresh_token as string | undefined,
          instance_url: instanceUrl,
          issued_at: tokenData.issued_at as string | undefined,
          username,
          expires_at: Date.now() + 2 * 60 * 60 * 1000,
          login_url: loginBase,
        };

        saveToken(accountId, token);

        const config = loadAccounts();
        const existingIdx = config.accounts.findIndex((a) => a.id === accountId);
        const account: SalesforceAccount = {
          id: accountId,
          username,
          instance_url: instanceUrl,
          is_sandbox: isSandbox,
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
      const scopes = process.env.SALESFORCE_OAUTH_SCOPES || 'api refresh_token';
      const authorizeUrl =
        `${loginBase}/services/oauth2/authorize?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: scopes,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        }).toString();

      console.error(`[Salesforce MCP] Open this URL to authenticate:\n${authorizeUrl}`);
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
