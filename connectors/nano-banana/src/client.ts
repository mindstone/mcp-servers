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
  getGeminiRequestTimeoutMs,
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

  const timeoutMs = getGeminiRequestTimeoutMs();
  // Compose caller-supplied signal (if any) with our timeout so the built-in
  // ceiling always applies — even when a caller passes its own AbortSignal.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const fetchSignal =
    signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  try {
    response = await fetch(url, {
      method: 'POST',
      signal: fetchSignal,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Attribute the abort to the timeout only when the timeout was the
    // *winning* signal — inspecting the composed signal's reason handles the
    // race where both caller-supplied abort and timeout fire near-simultaneously.
    const composedReason = fetchSignal.reason as { name?: string } | undefined;
    const timedOut =
      composedReason?.name === 'TimeoutError' ||
      (signal === undefined && error instanceof Error && error.name === 'TimeoutError');
    if (timedOut) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      throw new NanoBananaError(
        `Request to Gemini API timed out after ${timeoutSec}s`,
        'TIMEOUT',
        `The request took longer than ${timeoutSec}s. Gemini Pro image generations can be slow; set NANO_BANANA_GEMINI_TIMEOUT_MS to increase the timeout, or try again.`,
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
