/**
 * Freshdesk API HTTP client.
 *
 * Centralises Basic auth header injection, error handling, rate-limit
 * messaging, and domain URL construction for all Freshdesk API calls.
 *
 * Rate limiting: Freshdesk enforces per-minute, per-plan caps and returns
 * 429 with a Retry-After header. GET requests are retried in place (max 2
 * retries, honouring Retry-After capped at 30s, plus jitter) because they
 * are idempotent; writes are not retried automatically — a retried POST
 * could create duplicate tickets/replies — and surface RATE_LIMITED
 * immediately.
 *
 * Auth: Authorization: Basic base64(apiKey:X)
 * Base URL: https://{domain}.freshdesk.com/api/v2
 */

import { FreshdeskError, REQUEST_TIMEOUT_MS } from './types.js';
import { validateSubdomain } from './utils.js';

export interface FreshdeskFetchOptions extends RequestInit {
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
 * Make an authenticated request to the Freshdesk API.
 *
 * @param domain   Freshdesk subdomain (e.g. "acme")
 * @param apiKey   Freshdesk API key
 * @param endpoint Path relative to /api/v2, e.g. '/tickets'
 * @param options  Additional fetch options (method, body, headers, params)
 * @returns Parsed JSON response
 */
export async function freshdeskFetch<T>(
  domain: string,
  apiKey: string,
  endpoint: string,
  options: FreshdeskFetchOptions = {},
): Promise<T> {
  // Defence-in-depth: validate domain before URL construction
  validateSubdomain(domain);

  const { params, ...fetchOptions } = options;

  // Build URL with query params
  let url = `https://${domain}.freshdesk.com/api/v2${endpoint}`;
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

  // Build auth header: Basic base64("{apiKey}:X")
  const authHeader = `Basic ${Buffer.from(`${apiKey}:X`).toString('base64')}`;
  const method = (fetchOptions.method ?? 'GET').toUpperCase();

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    // Log method + path only. The full URL can carry query params holding
    // PII (contact email filters) or arbitrary search terms; those never
    // belong in logs.
    console.error(`[Freshdesk API] ${method} ${endpoint}`);

    let response: Response;

    try {
      response = await fetch(url, {
        ...fetchOptions,
        signal: fetchOptions.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(fetchOptions.headers as Record<string, string>),
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new FreshdeskError(
          'Request to Freshdesk API timed out',
          'TIMEOUT',
          'The request took too long. Try again or check if the Freshdesk instance is available.',
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
        throw new FreshdeskError(
          `Rate limited. Please wait ${waitTime} before retrying.`,
          'RATE_LIMITED',
          `Wait ${waitTime} and try again. Freshdesk rate limits vary by plan (Blossom: 100/min, Estate: 400/min, Forest: 700/min).`,
        );
      }
      const waitMs = parseRetryAfterMs(response.headers.get('Retry-After'));
      const jitter = Math.floor(Math.random() * 500);
      console.error(
        `[Freshdesk API] Rate limited, retrying in ${waitMs + jitter}ms (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs + jitter));
      continue;
    }

    // Handle auth errors
    if (response.status === 401) {
      throw new FreshdeskError(
        'Authentication failed',
        'AUTH_FAILED',
        'API key is invalid or revoked. Check your Freshdesk API key in your MCP host\'s settings.',
      );
    }

    // Handle forbidden
    if (response.status === 403) {
      throw new FreshdeskError(
        'Access forbidden',
        'AUTH_FAILED',
        'Your API key does not have permission for this operation. Check your Freshdesk plan and role.',
      );
    }

    // Handle not found
    if (response.status === 404) {
      throw new FreshdeskError(
        'Resource not found',
        'NOT_FOUND',
        'The requested resource does not exist or you do not have permission to access it.',
      );
    }

    // Handle other errors
    if (!response.ok) {
      // Drain the body for connection hygiene, but never log or surface it:
      // vendor error payloads can embed rejected request values, PII, or
      // custom-field content.
      await response.text().catch(() => '');
      console.error(`Freshdesk API error (${response.status}) for ${method} ${endpoint}`);

      const statusMessage =
        response.status === 422
          ? 'Validation error - check request parameters'
          : response.status >= 500
            ? 'Freshdesk server error - try again later'
            : 'Request failed';

      throw new FreshdeskError(
        `Freshdesk API error (${response.status}): ${statusMessage}`,
        'API_ERROR',
        'Check the request parameters and try again. If the problem persists, reconnect your Freshdesk account in your MCP host\'s settings.',
      );
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    // A successful status with a non-JSON body is still a vendor-controlled
    // response: the native JSON parse error can quote fragments of that body,
    // so convert it to a fixed, connector-authored error instead.
    try {
      return (await response.json()) as T;
    } catch {
      console.error(`[Freshdesk API] Unparseable success response for ${method} ${endpoint}`);
      throw new FreshdeskError(
        `Freshdesk API error (${response.status}): response body could not be parsed`,
        'API_ERROR',
        'Try the request again. If the problem persists, reconnect your Freshdesk account in your MCP host\'s settings.',
      );
    }
  }

  // Unreachable: the loop either returns a response or throws. Kept so the
  // compiler can prove every code path returns or throws.
  throw new FreshdeskError(
    'Rate-limit retry loop exited unexpectedly',
    'API_ERROR',
    'Try the request again.',
  );
}
