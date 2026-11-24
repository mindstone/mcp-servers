/**
 * Fathom API HTTP client.
 *
 * Centralises X-Api-Key header injection, error handling, and rate-limit
 * messaging for all Fathom API calls.
 */

import type { z } from 'zod';
import { getApiKey } from './auth.js';
import { FathomError, FATHOM_API_BASE, REQUEST_TIMEOUT_MS } from './types.js';
import { envelopeErrorText } from './utils.js';

const MAX_RATE_LIMIT_RETRIES = 3;
// Bound the wait so a busy rate-limit window cannot stall a tool call for
// minutes; Fathom's window is 60s, so a Retry-After beyond this is pathological.
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * The error for a reply that is not valid JSON or does not match the expected
 * shape. The message is fixed: neither the vendor's body nor the schema
 * diagnostics are echoed, since both can carry attacker-influenced text.
 */
function invalidResponseError(): FathomError {
  return new FathomError(
    'Fathom returned an unexpected response',
    'INVALID_RESPONSE',
    'Fathom replied in a format this connector does not recognise. Try again later; if it keeps happening, the Fathom API may have changed.',
  );
}

/**
 * Send an authenticated request and return the successful Response.
 *
 * Retries 429 responses up to MAX_RATE_LIMIT_RETRIES times, honouring the
 * Retry-After header (falling back to exponential backoff) — the same
 * posture the official Fathom SDKs take. Every non-2xx status becomes a
 * FathomError.
 */
async function fathomRequest(
  path: string,
  options: RequestInit,
  retryCount = 0,
): Promise<Response> {
  const key = getApiKey();
  if (!key) {
    throw new FathomError(
      'Fathom API key not configured',
      'AUTH_REQUIRED',
      'Use configure_fathom_api_key to set your API key first.',
    );
  }

  const url = `${FATHOM_API_BASE}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'X-Api-Key': key,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      // After the spread so no caller can override it: a redirect would carry X-Api-Key to its target.
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new FathomError(
        'Request to Fathom API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the Fathom API is available.',
      );
    }
    throw error;
  }

  if (response.status === 401 || response.status === 403) {
    throw new FathomError(
      'Authentication failed',
      'AUTH_FAILED',
      'Your Fathom API key is invalid or revoked. Use configure_fathom_api_key to set a new key.',
    );
  }

  if (response.status === 429) {
    if (retryCount < MAX_RATE_LIMIT_RETRIES) {
      const retryAfterSeconds = parseInt(response.headers.get('Retry-After') ?? '', 10);
      const waitMs = Number.isFinite(retryAfterSeconds)
        ? Math.min(retryAfterSeconds * 1000, MAX_RATE_LIMIT_WAIT_MS)
        : Math.min(1000 * Math.pow(2, retryCount), 8000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return fathomRequest(path, options, retryCount + 1);
    }
    // Show the header only when it is a plain number of seconds: it is
    // vendor-controlled text and must not reach the agent otherwise
    const retryAfter = response.headers.get('Retry-After')?.trim() ?? '';
    const waitTime = /^\d{1,6}$/.test(retryAfter) ? `${retryAfter} seconds` : 'a moment';
    throw new FathomError(
      `Rate limited by Fathom API after ${MAX_RATE_LIMIT_RETRIES} retries. Please wait ${waitTime} before retrying.`,
      'RATE_LIMITED',
      `Wait ${waitTime} and try again. Fathom limits API requests to 60 calls per minute.`,
    );
  }

  if (response.status === 404) {
    throw new FathomError(
      'Resource not found',
      'NOT_FOUND',
      'The requested resource does not exist or you do not have permission to access it.',
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new FathomError(
      `Fathom API error (${response.status}): ${envelopeErrorText(errorText, 'fathom:api.error_body')}`,
      'API_ERROR',
      'Check the request parameters and try again.',
    );
  }

  return response;
}

/**
 * Make an authenticated request to the Fathom API and parse its JSON body
 * with `schema`. A body that is not JSON, or does not match the schema,
 * fails with INVALID_RESPONSE.
 *
 * @param path  API path relative to base, e.g. `/meetings`
 * @param schema  Zod schema the reply must match
 * @param options  Additional fetch options
 * @returns The parsed, schema-checked reply
 */
export async function fathomFetch<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  options: RequestInit = {},
): Promise<z.infer<S>> {
  const response = await fathomRequest(path, options);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidResponseError();
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidResponseError();
  return parsed.data;
}

/**
 * Make an authenticated request whose success reply carries no body that the
 * caller needs (e.g. webhook deletion, which answers 204 No Content). Any
 * body Fathom does send is discarded unread.
 */
export async function fathomFetchNoContent(path: string, options: RequestInit = {}): Promise<void> {
  const response = await fathomRequest(path, options);
  await response.body?.cancel();
}
