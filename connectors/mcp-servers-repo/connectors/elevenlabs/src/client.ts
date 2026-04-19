/**
 * ElevenLabs API HTTP client.
 *
 * Centralises xi-api-key header injection, error handling, rate-limit
 * messaging, and timeout handling for all ElevenLabs API calls.
 *
 * Auth: xi-api-key: {key} (NOT Bearer, NOT Basic)
 * Base URL: https://api.elevenlabs.io/v1
 * Voices URL: https://api.elevenlabs.io/v2/voices
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  ElevenLabsError,
  REQUEST_TIMEOUT_MS,
  getErrorResolution,
  type AudioResult,
} from './types.js';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

/**
 * Make an authenticated request to the ElevenLabs API.
 * Returns a raw Response object.
 */
export async function elevenLabsFetch(
  apiKey: string,
  urlPath: string,
  options: RequestInit = {},
): Promise<Response> {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new ElevenLabsError(
      'ElevenLabs API key not configured',
      'AUTH_REQUIRED',
      'Configure your ElevenLabs API key in Settings. Get one at https://elevenlabs.io/app/settings/api-keys',
    );
  }

  const url = urlPath.startsWith('https://')
    ? urlPath
    : `${ELEVENLABS_API_BASE}${urlPath}`;

  const headers: Record<string, string> = {
    'xi-api-key': apiKey,
    ...(options.headers as Record<string, string> || {}),
  };

  // Only set Content-Type for JSON bodies (not FormData)
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  console.error(`[ElevenLabs API] ${options.method || 'GET'} ${url}`);

  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ElevenLabsError(
        'Request to ElevenLabs API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the ElevenLabs API is available.',
      );
    }
    throw error;
  }

  // Handle rate limiting
  if (response.status === 429) {
    throw new ElevenLabsError(
      'Rate limited. Please wait a moment before retrying.',
      'RATE_LIMITED',
      getErrorResolution(429),
    );
  }

  // Handle auth errors
  if (response.status === 401) {
    throw new ElevenLabsError(
      'Authentication failed',
      'AUTH_FAILED',
      getErrorResolution(401),
    );
  }

  if (response.status === 403) {
    let detail = '';
    try {
      const errBody = await response.clone().json() as { detail?: { message?: string } | string };
      if (typeof errBody.detail === 'string') {
        detail = errBody.detail;
      } else if (errBody.detail?.message) {
        detail = errBody.detail.message;
      }
    } catch { /* not JSON */ }
    throw new ElevenLabsError(
      `Access forbidden: ${detail || 'insufficient permissions or quota'}`,
      'AUTH_FAILED',
      getErrorResolution(403, detail),
    );
  }

  // Handle other errors
  if (!response.ok) {
    let detail = '';
    try {
      const errBody = await response.clone().json() as { detail?: { message?: string } | string };
      if (typeof errBody.detail === 'string') {
        detail = errBody.detail;
      } else if (errBody.detail?.message) {
        detail = errBody.detail.message;
      }
    } catch { /* not JSON */ }

    throw new ElevenLabsError(
      `ElevenLabs API error (HTTP ${response.status}): ${detail || response.statusText}`,
      `HTTP_${response.status}`,
      getErrorResolution(response.status, detail),
    );
  }

  return response;
}

/**
 * Make a JSON API call and parse the response.
 */
export async function elevenLabsJson<T>(
  apiKey: string,
  urlPath: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await elevenLabsFetch(apiKey, urlPath, options);
  return (await response.json()) as T;
}

/**
 * Make an API call that returns raw audio binary. Save to file and return path.
 */
export async function elevenLabsAudio(
  apiKey: string,
  urlPath: string,
  options: RequestInit = {},
  fileExtension = 'mp3',
): Promise<AudioResult> {
  const response = await elevenLabsFetch(apiKey, urlPath, options);

  const buffer = Buffer.from(await response.arrayBuffer());
  const fileName = `elevenlabs_${crypto.randomUUID()}.${fileExtension}`;
  const filePath = path.join(os.tmpdir(), fileName);
  fs.writeFileSync(filePath, buffer);

  return { filePath, sizeBytes: buffer.length };
}
