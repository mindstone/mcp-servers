/**
 * Fathom API HTTP client.
 *
 * Centralises X-Api-Key header injection, error handling, and rate-limit
 * messaging for all Fathom API calls.
 */

import { getApiKey } from './auth.js';
import { FathomError, FATHOM_API_BASE, REQUEST_TIMEOUT_MS } from './types.js';

const MAX_RATE_LIMIT_RETRIES = 3;
// Bound the wait so a busy rate-limit window cannot stall a tool call for
// minutes; Fathom's window is 60s, so a Retry-After beyond this is pathological.
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * Make an authenticated request to the Fathom API.
 *
 * Retries 429 responses up to MAX_RATE_LIMIT_RETRIES times, honouring the
 * Retry-After header (falling back to exponential backoff) — the same
 * posture the official Fathom SDKs take.
 *
 * @param path  API path relative to base, e.g. `/meetings`
 * @param options  Additional fetch options
 * @param retryCount  Internal retry counter for rate-limit handling
 * @returns Parsed JSON response
 */
export async function fathomFetch<T>(
  path: string,
  options: RequestInit = {},
  retryCount = 0,
): Promise<T> {
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
      return fathomFetch<T>(path, options, retryCount + 1);
    }
    const retryAfter = response.headers.get('Retry-After');
    const waitTime = retryAfter ? `${retryAfter} seconds` : 'a moment';
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
      `Fathom API error (${response.status}): ${errorText}`,
      'API_ERROR',
      'Check the request parameters and try again.',
    );
  }

  return response.json() as Promise<T>;
}
