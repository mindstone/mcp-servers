import {
  createGraphClientWithRetry,
  createLogger,
  type Client,
  type GraphClientWithRetry,
  type TokenProvider,
} from '@mindstone/mcp-server-microsoft-shared';

const log = createLogger('microsoft-mail-mcp');

const MS_CONFIG_DIR = process.env.MS_CONFIG_DIR ?? '';
const MS_CLIENT_ID = process.env.MS_CLIENT_ID ?? '';
const MS_ACCOUNT_EMAIL = process.env.MS_ACCOUNT_EMAIL || undefined;

let cached: GraphClientWithRetry | null = null;
let initError: string | null = null;

function ensureInitialized(): GraphClientWithRetry {
  if (cached) return cached;
  if (initError) throw new Error(initError);

  if (!MS_CONFIG_DIR || !MS_CLIENT_ID) {
    initError =
      'Missing required environment variables: MS_CONFIG_DIR, MS_CLIENT_ID. Connect Microsoft 365 via the host application before invoking tools.';
    log.error(initError);
    throw new Error(initError);
  }

  cached = createGraphClientWithRetry({
    configDir: MS_CONFIG_DIR,
    clientId: MS_CLIENT_ID,
    email: MS_ACCOUNT_EMAIL,
  });
  return cached;
}

export function getGraphClient(): Client {
  return ensureInitialized().client;
}

export function getTokenProvider(): TokenProvider {
  return ensureInitialized().tokenProvider;
}

/**
 * Invoke a Graph operation with a single retry on HTTP 401: cached token is
 * invalidated and the operation is retried so a transient stale-cache hit
 * doesn't fail the tool call. Mirrors the bundled `microsoft-mail` retry
 * semantics in `resources/mcp/microsoft-mail/src/index.ts`.
 */
export async function withGraphRetry<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const { client, tokenProvider } = ensureInitialized();
  try {
    return await fn(client);
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 401) {
      log.warn('Got 401, invalidating cached token and retrying');
      tokenProvider.invalidateCachedToken();
      return fn(client);
    }
    throw err;
  }
}
