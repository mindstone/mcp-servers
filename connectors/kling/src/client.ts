/**
 * Kling API HTTP client.
 *
 * Centralises JWT Bearer auth injection, error handling, rate-limit
 * messaging, and timeout handling for all Kling API calls.
 */

import { isConfigured, getJwtToken } from './auth.js';
import {
  KlingError,
  KLING_API_BASE,
  getRequestTimeoutMs,
  type KlingApiResponse,
} from './types.js';

/**
 * Get user-friendly resolution for common Kling error codes.
 */
function getErrorResolution(code: number, message?: string): string {
  const msg = message?.toLowerCase() || '';

  // Kling-specific error codes
  if (code >= 1000 && code <= 1004) {
    return 'Authentication failed. Check your Kling API credentials in Settings. Get keys from https://app.klingai.com/global/dev/api-key';
  }
  if (code === 1102) {
    return 'Insufficient credits. Purchase more at https://app.klingai.com/global/dev/billing';
  }
  if (code === 1201) {
    return 'Invalid request parameters. Check the prompt, model, and other settings.';
  }

  // Fallback to message-based matching
  if (msg.includes('auth') || msg.includes('token')) {
    return 'Check your Kling API credentials in Settings. Get keys from https://app.klingai.com/global/dev/api-key';
  }
  if (
    msg.includes('insufficient') ||
    msg.includes('balance') ||
    msg.includes('credit') ||
    msg.includes('not enough')
  ) {
    return 'Insufficient credits. Purchase more at https://app.klingai.com/global/dev/billing';
  }
  if (msg.includes('content') || msg.includes('policy') || msg.includes('moderation')) {
    return 'Content policy violation. Try a different prompt without sensitive content.';
  }
  return 'Please try again. If the issue persists, check the Kling AI status page.';
}

/**
 * Make an authenticated request to the Kling API.
 *
 * @param path  API path relative to base, e.g. `/videos/text2video`
 * @param options  Additional fetch options
 * @returns Parsed response data (unwrapped from Kling's { code, message, data } envelope)
 */
export async function klingFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!isConfigured()) {
    throw new KlingError(
      'Kling API credentials not configured',
      'AUTH_REQUIRED',
      'Use configure_kling_api_keys to set your access key and secret key first.',
    );
  }

  const jwt = await getJwtToken();
  // A full https:// URL bypasses the base prefix — needed for the account
  // costs endpoint, which Kling documents at the domain root (/account/costs)
  // rather than under /v1.
  const url = path.startsWith('https://') ? path : `${KLING_API_BASE}${path}`;

  let response: Response;

  const timeoutMs = getRequestTimeoutMs();
  // Compose caller-supplied signal (if any) with our timeout so the built-in
  // ceiling always applies — even when a caller passes its own AbortSignal.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callerSignal = options.signal ?? undefined;
  const fetchSignal =
    callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]);

  try {
    response = await fetch(url, {
      ...options,
      signal: fetchSignal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        ...options.headers,
      },
    });
  } catch (error) {
    // Attribute timeout to OUR signal only (not any caller-supplied TimeoutError):
    // timeoutSignal.aborted goes true iff its timer actually expired. If the caller
    // aborted first, their AbortError rethrows unchanged.
    if (timeoutSignal.aborted) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      throw new KlingError(
        `Request to Kling API timed out after ${timeoutSec}s`,
        'TIMEOUT',
        `The request took longer than ${timeoutSec}s. Set KLING_REQUEST_TIMEOUT_MS to increase the timeout, or try again.`,
      );
    }
    throw error;
  }

  // Handle rate limiting
  if (response.status === 429) {
    let bodyText: string | undefined;
    try {
      bodyText = await response.text();
    } catch {
      /* ignore */
    }
    let parsed: KlingApiResponse<T> | undefined;
    try {
      parsed = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      /* ignore */
    }
    if (parsed?.code && parsed.message) {
      throw new KlingError(
        parsed.message,
        `KLING_${parsed.code}`,
        getErrorResolution(parsed.code, parsed.message),
      );
    }
    const retryAfter = response.headers.get('Retry-After');
    const waitTime = retryAfter ? `${retryAfter} seconds` : '30 seconds';
    throw new KlingError(
      `Rate limited by Kling API. Please wait ${waitTime} before retrying.`,
      'RATE_LIMITED',
      `Wait ${waitTime} and try again.`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new KlingError(
      'Authentication failed',
      'AUTH_FAILED',
      'Your Kling API credentials are invalid or expired. Use configure_kling_api_keys to set new credentials.',
    );
  }

  // Handle non-OK responses that may not be JSON
  if (!response.ok) {
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch {
      bodyText = '';
    }
    let parsed: KlingApiResponse<T> | undefined;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      /* not JSON */
    }
    if (parsed?.code !== undefined) {
      throw new KlingError(
        parsed.message || `Kling API error (HTTP ${response.status})`,
        `KLING_${parsed.code}`,
        getErrorResolution(parsed.code, parsed.message),
      );
    }
    throw new KlingError(
      `Kling API error (HTTP ${response.status})`,
      `HTTP_${response.status}`,
      response.status === 404
        ? 'The API endpoint was not found. The Kling API may have changed.'
        : 'Please try again. If the issue persists, check your API credentials.',
    );
  }

  const data = (await response.json()) as KlingApiResponse<T>;

  // Kling API returns code 0 for success
  if (data.code !== 0) {
    throw new KlingError(
      data.message || `Kling API error: ${data.code}`,
      `KLING_${data.code}`,
      getErrorResolution(data.code, data.message),
    );
  }

  return data.data;
}
