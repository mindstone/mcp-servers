/**
 * Mixmax API HTTP client.
 *
 * Centralises X-API-Token header injection, error handling, and rate-limit
 * messaging for all Mixmax API calls.
 */

import { getApiToken } from './auth.js';
import { MixmaxError, MIXMAX_API_BASE, REQUEST_TIMEOUT_MS } from './types.js';

/**
 * Make an authenticated request to the Mixmax API.
 *
 * @param path  API path relative to base, e.g. `/sequences`
 * @param options  Additional fetch options
 * @returns Parsed JSON response
 */
export async function mixmaxFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getApiToken();
  if (!token) {
    throw new MixmaxError(
      'Mixmax API token not configured',
      'AUTH_REQUIRED',
      'Use configure_mixmax_api_key to set your API token first.',
    );
  }

  const url = `${MIXMAX_API_BASE}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'X-API-Token': token,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new MixmaxError(
        'Request to Mixmax API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the Mixmax API is available.',
      );
    }
    throw error;
  }

  if (response.status === 401 || response.status === 403) {
    throw new MixmaxError(
      'Authentication failed',
      'AUTH_FAILED',
      'Your Mixmax API token is invalid or revoked. Use configure_mixmax_api_key to set a new token.',
    );
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
    const waitSeconds = Number.isFinite(parsed) ? parsed : 60;
    throw new MixmaxError(
      `Rate limited by Mixmax API. Please wait ${waitSeconds} seconds before retrying.`,
      'RATE_LIMITED',
      `Wait ${waitSeconds} seconds and try again. Mixmax limits to 120 requests per minute.`,
    );
  }

  if (response.status === 404) {
    throw new MixmaxError(
      'Resource not found',
      'NOT_FOUND',
      'The requested resource does not exist or you do not have permission to access it.',
    );
  }

  if (!response.ok) {
    // Drain the body (frees the connection) but NEVER surface it: vendor error
    // bodies are attacker-influenceable — they can carry prompt-injection
    // payloads or echo request data (email bodies, recipients, tokens) straight
    // into model-visible output. Map to a fixed, safe message instead.
    await response.text().catch(() => '');
    throw new MixmaxError(
      `Mixmax API error (${response.status})`,
      'API_ERROR',
      'Check the request parameters and try again.',
    );
  }

  // Some endpoints (e.g. POST with 204) may return empty body
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A malformed success body must not surface raw parse diagnostics (which
    // can embed response fragments) — fail with a fixed, safe message.
    throw new MixmaxError(
      'Malformed JSON in Mixmax API response',
      'INVALID_API_RESPONSE',
      'The Mixmax API returned a malformed response. Try again, or update the connector if the problem persists.',
    );
  }
}
