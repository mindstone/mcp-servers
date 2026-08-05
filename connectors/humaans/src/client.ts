/**
 * Humaans API HTTP client.
 *
 * Centralises Bearer auth header injection, error handling, rate-limit
 * messaging, and timeout handling for all Humaans API calls.
 */

import { getApiKey } from './auth.js';
import { wrapUntrusted } from './untrusted-content.js';
import {
  HumaansError,
  HUMAANS_API_BASE,
  REQUEST_TIMEOUT_MS,
  type HumaansErrorResponse,
} from './types.js';

// Vendor error bodies are external text: envelope them before they reach the
// model (invariant #6) and cap their length so an HTML error page cannot dump
// an unbounded body into the conversation.
const MAX_VENDOR_ERROR_CHARS = 500;

/**
 * Format a Humaans API error response into a human-readable message. The
 * vendor-authored text is wrapped in an untrusted-content envelope.
 */
function formatApiError(error: HumaansErrorResponse): string {
  let msg = `${error.name} (${error.code}): ${error.message}`;
  if (error.issues && error.issues.length > 0) {
    const issueLines = error.issues.map(
      (i) => `  - ${i.name}: ${i.reason}${i.forbidden ? ' (insufficient permissions)' : ''}`,
    );
    msg += '\n' + issueLines.join('\n');
  }
  const wrapped = wrapUntrusted(msg.slice(0, MAX_VENDOR_ERROR_CHARS), 'humaans:api-error');
  return wrapped ?? 'Unknown error';
}

/**
 * Make an authenticated request to the Humaans API.
 *
 * @param path  API path relative to base, e.g. `/people`
 * @param options  Additional fetch options
 * @returns Parsed JSON response
 */
export async function humaansFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const key = getApiKey();
  if (!key) {
    throw new HumaansError(
      'Humaans API key not configured',
      'AUTH_REQUIRED',
      'Use configure_humaans_api_key to set your API key first.',
    );
  }

  const url = `${HUMAANS_API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new HumaansError(
        'Request to Humaans API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the Humaans API is available.',
      );
    }
    throw error;
  }

  if (response.status === 401 || response.status === 403) {
    throw new HumaansError(
      'Authentication failed',
      'AUTH_FAILED',
      'Your Humaans API token is invalid or lacks required scopes. Use configure_humaans_api_key to set a new token.',
    );
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const waitTime = retryAfter ? `${retryAfter} seconds` : 'a moment';
    throw new HumaansError(
      `Rate limited by Humaans API. Please wait ${waitTime} before retrying.`,
      'RATE_LIMITED',
      `Wait ${waitTime} and try again.`,
    );
  }

  if (response.status === 404) {
    throw new HumaansError(
      'Resource not found',
      'NOT_FOUND',
      'The requested resource does not exist or you do not have permission to access it.',
    );
  }

  if (!response.ok) {
    // Read the body exactly once — a failed JSON parse consumes it.
    const errorText = await response.text().catch(() => '');
    let errorBody: HumaansErrorResponse | undefined;
    if (errorText.length > 0) {
      try {
        errorBody = JSON.parse(errorText) as HumaansErrorResponse;
      } catch {
        // Response is not JSON
      }
    }

    if (errorBody && typeof errorBody.message === 'string') {
      throw new HumaansError(
        formatApiError(errorBody),
        'API_ERROR',
        'Check the request parameters and try again.',
      );
    }

    // Non-JSON (or wrong-shaped) vendor error body: it is external text, so
    // envelope it and cap its length rather than interpolating it raw.
    const detail =
      errorText.length > 0
        ? (wrapUntrusted(errorText.slice(0, MAX_VENDOR_ERROR_CHARS), 'humaans:api-error') ??
          'unreadable response body')
        : 'no response body';
    throw new HumaansError(
      `Humaans API error (${response.status}): ${detail}`,
      'API_ERROR',
      'Check the request parameters and try again.',
    );
  }

  return response.json() as Promise<T>;
}
