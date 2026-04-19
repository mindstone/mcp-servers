/**
 * Nano Banana / Gemini API HTTP client.
 *
 * Centralises query-param auth injection, error handling, rate-limit
 * messaging, and timeout handling for all Gemini API calls.
 *
 * Auth: ?key={GEMINI_API_KEY} query parameter (NOT header)
 * Base URL: https://generativelanguage.googleapis.com/v1beta
 */

import {
  NanoBananaError,
  REQUEST_TIMEOUT_MS,
  getErrorResolution,
  type GeminiResponse,
  type GeminiApiErrorData,
} from './types.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Make an authenticated request to the Gemini API.
 * The API key is injected as a query parameter.
 * Returns the parsed GeminiResponse.
 */
export async function geminiFetch(
  apiKey: string,
  modelPath: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GeminiResponse> {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new NanoBananaError(
      'Gemini API key not configured',
      'AUTH_REQUIRED',
      'Configure your Gemini API key. Get one at https://aistudio.google.com/api-keys',
    );
  }

  const url = `${GEMINI_API_BASE}/models/${modelPath}:generateContent?key=${apiKey}`;

  // Log URL without key
  console.error(`[NanoBanana API] POST ${GEMINI_API_BASE}/models/${modelPath}:generateContent`);

  let response: Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new NanoBananaError(
        'Request to Gemini API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the Gemini API is available.',
      );
    }
    throw error;
  }

  // Handle rate limiting
  if (response.status === 429) {
    throw new NanoBananaError(
      'Rate limited. Please wait a moment before retrying.',
      'RATE_LIMITED',
      getErrorResolution(429),
    );
  }

  // Handle auth errors
  if (response.status === 401 || response.status === 403) {
    let detail = '';
    try {
      const errBody = await response.clone().json() as GeminiApiErrorData;
      detail = errBody.error?.message || '';
    } catch { /* not JSON */ }
    throw new NanoBananaError(
      'Authentication failed',
      'AUTH_FAILED',
      getErrorResolution(response.status, detail),
    );
  }

  // Handle other HTTP errors
  if (!response.ok) {
    let detail = '';
    try {
      const errBody = await response.clone().json() as GeminiApiErrorData;
      detail = errBody.error?.message || '';
    } catch { /* not JSON */ }

    throw new NanoBananaError(
      `Gemini API error (HTTP ${response.status}): ${detail || response.statusText}`,
      `HTTP_${response.status}`,
      getErrorResolution(response.status, detail),
    );
  }

  // Parse response
  try {
    return (await response.json()) as GeminiResponse;
  } catch {
    throw new NanoBananaError(
      'Failed to parse Gemini API response',
      'PARSE_ERROR',
      'The API returned an unparseable response. Try again.',
    );
  }
}
