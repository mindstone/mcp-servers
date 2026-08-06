/**
 * Wise API HTTP client.
 *
 * Centralises Bearer auth header injection, error handling, rate-limit
 * messaging, and URL construction for all Wise API calls.
 *
 * Rate limiting: Wise returns 429 with a Retry-After header. GET requests
 * are retried in place (max 2 retries, honouring Retry-After capped at 30s,
 * plus jitter) because they are idempotent; writes are not retried
 * automatically — a retried POST could create duplicate recipients/quotes —
 * and surface RATE_LIMITED immediately.
 *
 * Auth: Authorization: Bearer <api token>
 * Base URL: https://api.wise.com (production) or https://api.wise-sandbox.com
 */

import { WiseError, getRequestTimeoutMs } from './types.js';
import { getApiBaseUrl } from './auth.js';

export interface WiseFetchOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * Parse a Retry-After header into milliseconds, capped at 30s so a hostile
 * or pathological value cannot stall the process. Supports both the
 * delta-seconds and HTTP-date forms; defaults to 1s when absent/unparseable.
 */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return 1000;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) {
    return Math.max(0, Math.min(seconds * 1000, 30_000));
  }
  const dateMs = Date.parse(header);
  if (!isNaN(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), 30_000));
  }
  return 1000;
}

/**
 * Make an authenticated request to the Wise API.
 *
 * @param apiToken Wise API token
 * @param endpoint Path with version prefix, e.g. '/v2/profiles'
 * @param options  Additional fetch options (method, body, headers, params)
 * @returns Parsed JSON response
 */
export async function wiseFetch<T>(
  apiToken: string,
  endpoint: string,
  options: WiseFetchOptions = {},
): Promise<T> {
  const { params, ...fetchOptions } = options;

  let url = `${getApiBaseUrl()}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        searchParams.append(key, String(value));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      url += (url.includes('?') ? '&' : '?') + queryString;
    }
  }

  const method = (fetchOptions.method ?? 'GET').toUpperCase();

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    // Log method + path only. Query params can carry filters holding PII;
    // those never belong in logs.
    console.error(`[Wise API] ${method} ${endpoint}`);

    let response: Response;

    try {
      response = await fetch(url, {
        ...fetchOptions,
        signal: fetchOptions.signal ?? AbortSignal.timeout(getRequestTimeoutMs()),
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(fetchOptions.headers as Record<string, string>),
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new WiseError(
          'Request to Wise API timed out',
          'TIMEOUT',
          'The request took too long. Try again or check if the Wise API is available.',
        );
      }
      throw error;
    }

    // Handle rate limiting: retry idempotent GETs in place, honouring
    // Retry-After; everything else surfaces RATE_LIMITED immediately.
    if (response.status === 429) {
      if (method !== 'GET' || attempt >= MAX_RATE_LIMIT_RETRIES) {
        // The Retry-After header is vendor-controlled text: only a parsed
        // non-negative integer ever reaches the model-visible message, never
        // the raw header value.
        const retryAfterSeconds = parseInt(response.headers.get('Retry-After') ?? '', 10);
        const waitTime =
          !isNaN(retryAfterSeconds) && retryAfterSeconds >= 0
            ? `${retryAfterSeconds} seconds`
            : 'a moment';
        throw new WiseError(
          `Rate limited. Please wait ${waitTime} before retrying.`,
          'RATE_LIMITED',
          `Wait ${waitTime} and try again. Wise rate limits apply per endpoint and per token.`,
        );
      }
      const waitMs = parseRetryAfterMs(response.headers.get('Retry-After'));
      const jitter = Math.floor(Math.random() * 500);
      console.error(
        `[Wise API] Rate limited, retrying in ${waitMs + jitter}ms (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs + jitter));
      continue;
    }

    if (response.status === 401) {
      throw new WiseError(
        'Authentication failed',
        'AUTH_FAILED',
        'API token is invalid or revoked. Reconnect your Wise account with a fresh API token from wise.com (Settings → API tokens).',
      );
    }

    if (response.status === 403) {
      throw new WiseError(
        'Access forbidden',
        'AUTH_FAILED',
        'Your API token does not have permission for this operation. Some Wise endpoints are restricted for personal API tokens or require additional scopes.',
      );
    }

    if (response.status === 404) {
      throw new WiseError(
        'Resource not found',
        'NOT_FOUND',
        'The requested resource does not exist or you do not have permission to access it. Check the id and that it belongs to one of your Wise profiles.',
      );
    }

    if (!response.ok) {
      // Drain the body for connection hygiene, but never log or surface it:
      // vendor error payloads can embed rejected request values or PII.
      await response.text().catch(() => '');
      console.error(`Wise API error (${response.status}) for ${method} ${endpoint}`);

      const statusMessage =
        response.status === 400 || response.status === 422
          ? 'Validation error - check request parameters (amounts, currencies, recipient details)'
          : response.status >= 500
            ? 'Wise server error - try again later'
            : 'Request failed';

      throw new WiseError(
        `Wise API error (${response.status}): ${statusMessage}`,
        'API_ERROR',
        'Check the request parameters and try again. If the problem persists, reconnect your Wise account.',
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    // A successful status with a non-JSON body is still a vendor-controlled
    // response: the native JSON parse error can quote fragments of that body,
    // so convert it to a fixed, connector-authored error instead.
    try {
      return (await response.json()) as T;
    } catch {
      console.error(`[Wise API] Unparseable success response for ${method} ${endpoint}`);
      throw new WiseError(
        `Wise API error (${response.status}): response body could not be parsed`,
        'API_ERROR',
        'Try the request again. If the problem persists, reconnect your Wise account.',
      );
    }
  }

  // Unreachable: the loop either returns a response or throws. Kept so the
  // compiler can prove every code path returns or throws.
  throw new WiseError(
    'Rate-limit retry loop exited unexpectedly',
    'API_ERROR',
    'Try the request again.',
  );
}
