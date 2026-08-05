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

// Connection cache per account
const connections = new Map<string, jsforce.Connection>();

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

  // Only hand jsforce a refresh token when we can also give it a way to USE
  // that token — i.e. the OAuth2 client info to build a refresh delegate.
  // jsforce throws synchronously at construction otherwise:
  // "Refresh token is specified without oauth2 client information or refresh function".
  // This is the bridge-mode case: the host app owns OAuth and does not pass
  // SALESFORCE_CLIENT_ID/SECRET into the connector, so we operate on the access
  // token alone and surface SESSION_EXPIRED (-> reconnect) on expiry rather than
  // crashing every tool call. (See docs/plans/260612_fix-salesforce-bridge-refresh-token/.)
  if (clientId && clientSecret && tokenData.refresh_token) {
    connectionConfig.oauth2 = { clientId, clientSecret, loginUrl };
    connectionConfig.refreshToken = tokenData.refresh_token;
  }

  const conn = new jsforce.Connection(connectionConfig);

  conn.on('refresh', async (accessToken: string) => {
    console.error(`[Salesforce MCP] Token refreshed for account ${resolvedId}`);
    const updatedToken: SalesforceTokenData = {
      ...tokenData,
      access_token: accessToken,
      expires_at: Date.now() + 2 * 60 * 60 * 1000,
    };
    saveToken(resolvedId, updatedToken);
  });

  connections.set(resolvedId, conn);
  return conn;
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
  try {
    return await operation(conn);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error.message.includes('INVALID_SESSION_ID') ||
        error.message.includes('Session expired'))
    ) {
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
