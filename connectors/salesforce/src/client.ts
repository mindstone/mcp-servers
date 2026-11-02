import jsforce from 'jsforce';
import {
  ConnectorError,
  SALESFORCE_API_VERSION,
  type SalesforceTokenData,
  type SalesforceAccount,
} from './types.js';
import {
  getAuthMode,
  getActiveToken,
  loadAccounts,
  loadToken,
  saveToken,
  deleteToken,
  saveAccounts,
} from './auth.js';

const TOKEN_SAVE_FAILED = 'Failed to save refreshed token';
const REFRESH_TOKEN_EXPIRED = 'expired access/refresh token';

// Connection cache per account
const connections = new Map<string, jsforce.Connection>();
const unsavedTokens = new WeakMap<jsforce.Connection, () => void>();

function getLoginUrl(tokenData: SalesforceTokenData): string {
  if (tokenData.login_url) return tokenData.login_url;
  const isSandbox =
    tokenData.instance_url.includes('test.salesforce.com') ||
    tokenData.instance_url.includes('.sandbox.') ||
    tokenData.instance_url.includes('.scratch.');
  return isSandbox
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com';
}

/**
 * Ensure the connector is in a mode that can make API calls.
 */
export function requireAuth(): void {
  const mode = getAuthMode();
  if (mode === 'unconfigured') {
    throw new ConnectorError(
      'No Salesforce authentication configured',
      'UNCONFIGURED',
      'Set up authentication: (1) Set SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET for OAuth, or (2) Set SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL for manual token mode. See README for details.',
    );
  }
}

/**
 * Get a jsforce connection for the current account.
 */
export async function getConnection(accountId?: string): Promise<jsforce.Connection> {
  requireAuth();

  const { accountId: resolvedId, token: tokenData } = accountId
    ? { accountId, token: loadToken(accountId)! }
    : getActiveToken();

  if (!tokenData) {
    throw new ConnectorError(
      `Account ${accountId} not found`,
      'ACCOUNT_NOT_FOUND',
      'Call salesforce_connect_account to connect.',
    );
  }

  // Check cache
  const cached = connections.get(resolvedId);
  if (cached) return cached;

  const loginUrl = getLoginUrl(tokenData);
  const clientId = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connectionConfig: any = {
    instanceUrl: tokenData.instance_url,
    accessToken: tokenData.access_token,
    version: SALESFORCE_API_VERSION,
  };

  // The host supplies OAuth client credentials in bridge mode too, so jsforce
  // normally refreshes the sign-in. Without them (manual token mode or a host
  // that supplies none), use the access token alone and report SESSION_EXPIRED
  // when it expires. jsforce requires client information with a refresh token.
  if (clientId && clientSecret && tokenData.refresh_token) {
    connectionConfig.oauth2 = { clientId, clientSecret, loginUrl };
    connectionConfig.refreshToken = tokenData.refresh_token;
  }

  const conn = new jsforce.Connection(connectionConfig);

  // With refresh-token rotation on (an org setting), each refresh returns a new
  // refresh token and retires the old one. jsforce passes the response here
  // but keeps presenting the old token itself, so take the new one up in the
  // live connection and in the saved token. `saved` carries each refresh's
  // result forward; re-saving from the token this connection was built with
  // would put a retired refresh token back on disk.
  let saved = tokenData;
  conn.on('refresh', (accessToken: string, res?: { refresh_token?: unknown }) => {
    console.error(`[Salesforce MCP] Token refreshed for account ${resolvedId}`);
    const rotated = typeof res?.refresh_token === 'string' && res.refresh_token ? res.refresh_token : undefined;
    if (rotated) conn.refreshToken = rotated;
    saved = {
      ...saved,
      access_token: accessToken,
      ...(rotated ? { refresh_token: rotated } : {}),
      expires_at: Date.now() + 2 * 60 * 60 * 1000,
    };
    try {
      saveToken(resolvedId, saved);
      unsavedTokens.delete(conn);
    } catch {
      unsavedTokens.set(conn, () => saveToken(resolvedId, saved));
      // The new token stays live in this connection, but the next process would
      // start from a retired one, so this must not pass silently. Throwing here
      // fails the refresh before jsforce replays the request, so a retry can't
      // repeat a write. Bounded message: a filesystem error can quote the path
      // or content.
      console.error(`[Salesforce MCP] Failed to save refreshed token for account ${resolvedId}`);
      throw new Error(TOKEN_SAVE_FAILED);
    }
  });

  connections.set(resolvedId, conn);
  return conn;
}

// The call starting a refresh gets jsforce's error with a prefix before the text;
// a call waiting on the same refresh gets the original error, unwrapped.
function isRefreshFailure(error: unknown, text: string): boolean {
  return error instanceof Error && !(error instanceof ConnectorError) && !('errorCode' in error) &&
    (error.message === text || error.message.endsWith(`: ${text}`));
}

/**
 * Recognize jsforce session errors even when the vendor message varies.
 */
export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof Error && (
    ('errorCode' in error && error.errorCode === 'INVALID_SESSION_ID') ||
    error.message.includes('INVALID_SESSION_ID') ||
    error.message.includes('Session expired') ||
    isRefreshFailure(error, REFRESH_TOKEN_EXPIRED)
  );
}

/**
 * Execute an operation with a jsforce connection, handling session expiry.
 */
export async function withConnection<T>(
  accountId: string | undefined,
  operation: (conn: jsforce.Connection) => Promise<T>,
): Promise<T> {
  requireAuth();

  const { accountId: resolvedId } = accountId
    ? { accountId }
    : getActiveToken();

  const conn = await getConnection(resolvedId);
  const savePendingToken = unsavedTokens.get(conn);
  if (savePendingToken) {
    try {
      savePendingToken();
      unsavedTokens.delete(conn);
    } catch {
      console.error(`[Salesforce MCP] Still could not save the refreshed token for account ${resolvedId}`);
    }
  }
  try {
    return await operation(conn);
  } catch (error: unknown) {
    if (isRefreshFailure(error, TOKEN_SAVE_FAILED)) {
      throw new ConnectorError(
        'Could not save the renewed Salesforce sign-in',
        'TOKEN_SAVE_FAILED',
        'The request did not run. Try it again. Check that the credentials folder is writable, or Salesforce may need reconnecting after a restart.',
      );
    }
    if (isSessionExpiredError(error)) {
      // Clear cached connection on session expiry
      connections.delete(resolvedId);
      throw new ConnectorError(
        'Session expired',
        'SESSION_EXPIRED',
        'Call salesforce_connect_account to re-connect.',
      );
    }
    throw error;
  }
}

/**
 * List all connected accounts with their status.
 */
export function listConnectedAccounts(): SalesforceAccount[] {
  const config = loadAccounts();
  return config.accounts.map((a) => {
    const token = loadToken(a.id);
    return {
      ...a,
      is_sandbox:
        a.instance_url?.includes('test.salesforce.com') ||
        a.instance_url?.includes('.sandbox.') ||
        false,
    };
  });
}

/**
 * Remove a connected account.
 */
export function removeAccount(usernameOrId: string): void {
  const config = loadAccounts();
  const account = config.accounts.find(
    (a) => a.username === usernameOrId || a.id === usernameOrId,
  );
  if (!account) {
    throw new ConnectorError(
      `Account not found: ${usernameOrId}`,
      'ACCOUNT_NOT_FOUND',
      'Use salesforce_list_connected_accounts to see connected accounts.',
    );
  }

  connections.delete(account.id);
  deleteToken(account.id);
  config.accounts = config.accounts.filter((a) => a.id !== account.id);
  saveAccounts(config);
  console.error(`[Salesforce MCP] Removed account: ${account.username}`);
}
