import { BROWSERBASE_API_BASE, ConnectorError, getRequestTimeoutMs } from './types.js';
import { envelopeApiErrorDetail } from './error-detail.js';

/** Mutable API key — set via configure_browserbase_api_key tool or BROWSERBASE_API_KEY env var. */
let apiKey = process.env.BROWSERBASE_API_KEY || '';

export function getApiKey(): string {
  return apiKey;
}

export function setApiKey(key: string): void {
  apiKey = key;
}

/**
 * Ensure API key is configured, otherwise throw a setup guidance error.
 */
export function requireApiKey(): void {
  if (!apiKey) {
    throw new ConnectorError(
      'Browserbase API key not configured',
      'AUTH_REQUIRED',
      'Configure your Browserbase API key using the configure_browserbase_api_key tool. Get a key at https://www.browserbase.com/settings',
    );
  }
}

/**
 * Map an HTTP status (plus the Fastify error detail and response headers) to
 * an actionable resolution. The resolution never echoes the API key and
 * always tells the LLM what to do next.
 */
function getErrorResolution(status: number, detail: string, retryAfterSeconds?: number): string {
  const msg = detail.toLowerCase();
  switch (status) {
    case 400:
      return 'Invalid request parameters. Check the error detail for the field that failed validation, fix the input, and retry. Non-UUID resource IDs are rejected with "Invalid … ID" — pass exact IDs returned by other tools.';
    case 401:
      return 'Authentication failed. Get a key at https://www.browserbase.com/settings and configure it with the configure_browserbase_api_key tool.';
    case 402:
      return 'Payment required. Add a payment method or upgrade your plan at https://www.browserbase.com/settings';
    case 403:
      return 'Insufficient permissions or quota exceeded for this operation. Check your plan at https://www.browserbase.com/settings';
    case 404:
      return 'Resource not found. The ID may be wrong, or the resource was deleted or expired. Use the matching list_* tool (list_sessions, list_agents, list_agent_runs, list_downloads, list_certificates, list_functions) to browse available resources.';
    case 409:
      return 'Conflict — the resource is in the wrong state for this operation (e.g. stopping an already-finished agent run, or requesting a recording download for a session whose recording is unavailable). Check the current state with the matching get_* tool before retrying.';
    case 410:
      return 'Gone — the underlying data has expired and been deleted (e.g. recording data past its retention window). It cannot be recovered; re-run the session if you need fresh data.';
    case 422:
      return 'Unprocessable request — the input was well-formed but cannot be completed in the current state (seen on recording-download edge cases). Check the resource state with the matching get_* tool and retry.';
    case 429:
      return retryAfterSeconds !== undefined
        ? `Rate limited (concurrency or session-creation limit). Wait ${retryAfterSeconds} seconds before retrying. Check running sessions with list_sessions and end unused ones with end_session, or raise limits at https://www.browserbase.com/settings`
        : 'Rate limited (concurrency or session-creation limit). Wait a moment and retry. Check running sessions with list_sessions and end unused ones with end_session, or raise limits at https://www.browserbase.com/settings';
    default:
      if (status >= 500) {
        return 'Browserbase upstream error. Retry the request — if it persists, check https://status.browserbase.com';
      }
      if (msg.includes('validation')) {
        return 'Invalid request parameters. Check the input values and try again.';
      }
      return 'Please try again. If the issue persists, check your API key and plan at https://www.browserbase.com/settings';
  }
}

/** Semantic ConnectorError code for a Browserbase HTTP error status. */
function getErrorCode(status: number): string {
  switch (status) {
    case 400: return 'VALIDATION_FAILED';
    case 401: return 'AUTH_REQUIRED';
    case 402: return 'PAYMENT_REQUIRED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 410: return 'GONE';
    case 422: return 'UNPROCESSABLE';
    case 429: return 'RATE_LIMITED';
    default: return status >= 500 ? 'UPSTREAM_ERROR' : `HTTP_${status}`;
  }
}

/** Parse the `retry-after` response header (seconds) when present. */
function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export interface BrowserbaseRequestOptions {
  method?: string;
  /** JSON-serializable request body, or FormData for multipart uploads. */
  body?: unknown;
  /** Query parameters; undefined values are skipped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Extra request headers (e.g. Accept overrides). */
  headers?: Record<string, string>;
}

/**
 * Perform an authenticated request against the Browserbase API and return the
 * raw Response after status checking. Use browserbaseFetch for JSON bodies;
 * this lower-level helper exists for non-JSON responses (m3u8 playlists,
 * binary downloads).
 */
async function browserbaseRequest(
  urlPath: string,
  options: BrowserbaseRequestOptions = {},
): Promise<Response> {
  requireApiKey();

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  const url = `${BROWSERBASE_API_BASE}${urlPath}${qs ? `?${qs}` : ''}`;

  // Multipart bodies (file uploads) must NOT carry a manual Content-Type —
  // fetch sets it with the correct boundary itself.
  const isMultipart = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers: Record<string, string> = {
    'X-BB-API-Key': apiKey,
    ...(options.body !== undefined && !isMultipart ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers ?? {}),
  };

  const timeoutMs = getRequestTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined
        ? undefined
        : isMultipart
          ? (options.body as FormData)
          : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ConnectorError(
        `Request timed out after ${Math.round(timeoutMs / 1000)} seconds`,
        'TIMEOUT',
        'The Browserbase API took too long to respond. Try again — if the issue persists, check https://status.browserbase.com',
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // Browserbase errors are Fastify JSON: {statusCode, error, message}
    // (+ code:"FST_ERR_VALIDATION" on 400 validation failures).
    let detail = '';
    try {
      const errBody = await response.json() as { message?: string; error?: string };
      detail = errBody.message || errBody.error || '';
    } catch { /* not JSON */ }

    // HTTP reason text is upstream-controlled metadata too: envelope it (or
    // fall back to a trusted generic placeholder) so raw upstream text never
    // reaches the model unwrapped (AGENTS.md security invariant #6).
    const upstreamDetail = detail || response.statusText || '';
    throw new ConnectorError(
      `Browserbase API error (HTTP ${response.status}): ${upstreamDetail ? envelopeApiErrorDetail(upstreamDetail) : 'no error detail returned'}`,
      getErrorCode(response.status),
      getErrorResolution(response.status, detail, parseRetryAfter(response)),
    );
  }

  return response;
}

/**
 * Make an authenticated API call to the Browserbase REST API, parsing the
 * response as JSON. 204 No Content responses resolve to `{}`.
 */
export async function browserbaseFetch<T>(
  urlPath: string,
  options: BrowserbaseRequestOptions = {},
): Promise<T> {
  const response = await browserbaseRequest(urlPath, options);

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return {} as T;
  }

  // Read as text first: several endpoints return empty bodies on non-204 2xx
  // (e.g. 202 Accepted for stop/download requests).
  const text = await response.text();
  if (text.trim() === '') {
    return {} as T;
  }

  // A malformed 2xx body must fail with a TRUSTED generic error: Node's JSON
  // parse errors embed the start of the response body, so rethrowing the raw
  // SyntaxError would leak upstream-authored bytes into model-visible output.
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConnectorError(
      `Browserbase API returned a malformed response (HTTP ${response.status}): expected JSON but the body could not be parsed`,
      'INVALID_RESPONSE',
      'The API returned an unexpected response body. Retry the request — if it persists, check https://status.browserbase.com',
    );
  }
}

/**
 * Fetch a plain-text response (e.g. an m3u8 replay playlist).
 */
export async function browserbaseFetchText(
  urlPath: string,
  options: BrowserbaseRequestOptions = {},
): Promise<string> {
  const response = await browserbaseRequest(urlPath, options);
  return response.text();
}

/**
 * Fetch a binary response (e.g. a downloaded file's bytes).
 */
export async function browserbaseFetchBytes(
  urlPath: string,
  options: BrowserbaseRequestOptions = {},
): Promise<{ data: Buffer; contentType: string | null; contentLength: number | null }> {
  const response = await browserbaseRequest(urlPath, options);
  const contentLengthRaw = response.headers.get('content-length');
  const contentLength = contentLengthRaw !== null ? Number(contentLengthRaw) : null;
  const data = Buffer.from(await response.arrayBuffer());
  return { data, contentType: response.headers.get('content-type'), contentLength };
}
