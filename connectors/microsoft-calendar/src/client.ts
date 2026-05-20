import {
  createGraphClientWithRetry,
  createLogger,
  type Client,
  type GraphClientWithRetry,
  type TokenProvider,
} from '@mindstone/mcp-server-microsoft-shared';
import { abortableSignal, extractCallerSignal, runWithSignal } from './utils.js';

const log = createLogger('microsoft-calendar-mcp');

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
 * doesn't fail the tool call. Mirrors the bundled `microsoft-calendar` retry
 * semantics in the bundled Microsoft Calendar connector.
 *
 * The composed `signal` is threaded into both the initial attempt and the
 * post-401 retry so a host cancellation or cohort timeout aborts the in-flight
 * Graph request regardless of which attempt is active.
 */
export async function withGraphRetry<T>(
  fn: (client: Client, signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const { client, tokenProvider } = ensureInitialized();
  try {
    return await fn(client, signal);
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 401) {
      log.warn('Got 401, invalidating cached token and retrying');
      tokenProvider.invalidateCachedToken();
      return fn(client, signal);
    }
    throw err;
  }
}

/**
 * Run a Graph operation under the cohort timeout + caller abort signal.
 *
 * Composes the per-call signal from `extra.signal` (when the MCP host
 * cancelled the request) with `REQUEST_TIMEOUT_MS`, then (a) hands it to the
 * SDK via `GraphRequest.options({ signal })` so the underlying fetch is
 * actually cancelled, and (b) races the SDK promise against the same signal as
 * defence-in-depth in case any middleware path drops the signal. See
 * `runWithSignal` in utils.ts for the race-wrapper rationale.
 */
export async function callGraph<T>(
  extra: unknown,
  fn: (client: Client, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = abortableSignal(extractCallerSignal(extra));
  return runWithSignal(withGraphRetry(fn, signal), signal);
}
