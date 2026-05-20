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

  // Handle auth errors. ElevenLabs returns 401 both for genuinely invalid
  // keys AND for valid keys missing a specific scope (e.g. sound_generation).
  // The latter ships a `detail.status = "missing_permissions"` payload that
  // the user needs to see in order to fix the key permissions; previously we
  // threw it away and emitted a bare "Authentication failed".
  if (response.status === 401) {
    const detail = await extractErrorDetail(response);
    const isMissingPermission = detail.includes('missing_permissions');
    throw new ElevenLabsError(
      isMissingPermission
        ? `API key missing required permission: ${detail}`
        : detail
          ? `Authentication failed: ${detail}`
          : 'Authentication failed',
      isMissingPermission ? 'MISSING_PERMISSION' : 'AUTH_FAILED',
      isMissingPermission
        ? 'Regenerate your API key at https://elevenlabs.io/app/settings/api-keys with the missing permission enabled, then call configure_elevenlabs_api_key again.'
        : getErrorResolution(401),
    );
  }

  if (response.status === 403) {
    const detail = await extractErrorDetail(response);
    throw new ElevenLabsError(
      `Access forbidden: ${detail || 'insufficient permissions or quota'}`,
      'AUTH_FAILED',
      getErrorResolution(403, detail),
    );
  }

  // Handle other errors
  if (!response.ok) {
    const detail = await extractErrorDetail(response);
    throw new ElevenLabsError(
      `ElevenLabs API error (HTTP ${response.status}): ${detail || response.statusText}`,
      `HTTP_${response.status}`,
      getErrorResolution(response.status, detail),
    );
  }

  return response;
}

/**
 * Extract a human-readable detail message from an ElevenLabs error response.
 *
 * The API uses several detail shapes:
 *  - `detail: "string message"` (legacy)
 *  - `detail: { message: "...", status?: "..." }` (current auth/permission errors)
 *  - `detail: [{ type, loc: ["body", "field", ...], msg, input }, ...]` (FastAPI 422)
 *
 * The 422 array form is the one that bit us in
 * `generate_music_from_plan`: previously we threw away the field-level info
 * and left the user with `HTTP 422: unknown`. We now flatten the validation
 * errors into something like
 *   `body.composition_plan.sections.0.section_name: Field required;
 *    body.composition_plan.sections.0.lines: Field required`
 * which is what an LLM agent actually needs to self-correct.
 */
async function extractErrorDetail(response: Response): Promise<string> {
  try {
    const errBody = (await response.clone().json()) as unknown;
    const d = (errBody as { detail?: unknown } | null)?.detail;
    if (d == null) return '';
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) {
      // FastAPI validation errors → "loc.path: msg" joined by "; ".
      // Skip null/non-object entries defensively rather than throwing.
      const parts = d
        .map((e) => {
          if (!e || typeof e !== 'object') return '';
          const entry = e as { loc?: unknown; msg?: unknown; type?: unknown };
          const loc = Array.isArray(entry.loc) ? entry.loc.join('.') : '';
          const msg = typeof entry.msg === 'string'
            ? entry.msg
            : typeof entry.type === 'string'
              ? entry.type
              : 'invalid';
          return loc ? `${loc}: ${msg}` : msg;
        })
        .filter((s) => s.length > 0);
      return parts.join('; ');
    }
    if (typeof d === 'object') {
      const o = d as { message?: unknown; status?: unknown; cause?: unknown };
      const parts: string[] = [];
      if (typeof o.status === 'string') parts.push(o.status);
      if (typeof o.message === 'string') parts.push(o.message);
      if (typeof o.cause === 'string') parts.push(`cause: ${o.cause}`);
      return parts.join(' — ');
    }
    return '';
  } catch {
    return '';
  }
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
