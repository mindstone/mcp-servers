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

import * as crypto from 'crypto';
import {
  ElevenLabsError,
  REQUEST_TIMEOUT_MS,
  getErrorResolution,
  type AudioResult,
} from './types.js';
import { ELEVENLABS_API_V1_BASE } from './endpoints.js';
import { envelopeApiErrorDetail, formatApiErrorMessage } from './error-detail.js';
import { writeWorkspaceArtifact } from './tools/path-safety.js';

export interface ElevenLabsFetchOptions extends RequestInit {
  /** Per-call timeout override (default REQUEST_TIMEOUT_MS). Explicit `signal` wins. */
  timeoutMs?: number;
}

/**
 * Make an authenticated request to the ElevenLabs API.
 * Returns a raw Response object.
 */
export async function elevenLabsFetch(
  apiKey: string,
  urlPath: string,
  options: ElevenLabsFetchOptions = {},
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
    : `${ELEVENLABS_API_V1_BASE}${urlPath}`;

  const { timeoutMs, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    'xi-api-key': apiKey,
    ...(fetchOptions.headers as Record<string, string> || {}),
  };

  // Only set Content-Type for JSON bodies (not FormData)
  if (!(fetchOptions.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  console.error(`[ElevenLabs API] ${fetchOptions.method || 'GET'} ${url}`);

  let response: Response;

  try {
    response = await fetch(url, {
      ...fetchOptions,
      signal: fetchOptions.signal ?? AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS),
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
    const envelopedDetail = detail ? envelopeApiErrorDetail(detail) : '';
    throw new ElevenLabsError(
      isMissingPermission
        ? `API key missing required permission: ${envelopedDetail}`
        : detail
          ? formatApiErrorMessage('Authentication failed', detail)
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
      detail
        ? formatApiErrorMessage('Access forbidden', detail)
        : 'Access forbidden: insufficient permissions or quota',
      'AUTH_FAILED',
      getErrorResolution(403, detail),
    );
  }

  // Handle other errors
  if (!response.ok) {
    const detail = await extractErrorDetail(response);
    const statusText = response.statusText
      ? envelopeApiErrorDetail(response.statusText)
      : '';
    throw new ElevenLabsError(
      detail
        ? `ElevenLabs API error (HTTP ${response.status}): ${envelopeApiErrorDetail(detail)}`
        : `ElevenLabs API error (HTTP ${response.status})${statusText ? `: ${statusText}` : ''}`,
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
 *
 * Raw detail is third-party-authored — callers must envelope before exposing
 * to model-visible output (see `envelopeApiErrorDetail`).
 */
export async function extractErrorDetail(response: Response): Promise<string> {
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
  options: ElevenLabsFetchOptions = {},
): Promise<T> {
  const response = await elevenLabsFetch(apiKey, urlPath, options);
  try {
    return (await response.json()) as T;
  } catch (error) {
    // A body-read abort or mid-stream timeout rejects here too — report it as
    // TIMEOUT so the remediation advice matches the actual fault, instead of
    // mislabelling a transient network failure as an API format change.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ElevenLabsError(
        'Timed out reading the ElevenLabs response body',
        'TIMEOUT',
        'The response took too long to download. Try again or check if the ElevenLabs API is available.',
      );
    }
    // A 200 with a non-JSON body would otherwise surface the runtime's
    // SyntaxError — whose message embeds an excerpt of the raw upstream body —
    // through the generic error path, unenveloped.
    throw new ElevenLabsError(
      'ElevenLabs returned a non-JSON response body',
      'INVALID_RESPONSE',
      'Retry the request; if it persists, the ElevenLabs API response format may have changed.',
    );
  }
}

/** Map response Content-Type to a file extension (OpenAPI drift — don't trust empty schemas). */
export function extensionFromContentType(contentType: string | null | undefined): string {
  if (!contentType) return 'mp3';
  const ct = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const map: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/webm': 'webm',
  };
  return map[ct] ?? 'mp3';
}

/**
 * Make an API call that returns raw audio binary. Save to file and return path.
 */
export async function elevenLabsAudio(
  apiKey: string,
  urlPath: string,
  options: ElevenLabsFetchOptions = {},
  fileExtension?: string,
): Promise<AudioResult> {
  const response = await elevenLabsFetch(apiKey, urlPath, options);
  const contentType = response.headers.get('content-type');
  const ext = fileExtension ?? extensionFromContentType(contentType);

  const buffer = Buffer.from(await response.arrayBuffer());
  const fileName = `elevenlabs_${crypto.randomUUID()}.${ext}`;
  const filePath = writeWorkspaceArtifact(fileName, buffer);

  return { filePath, sizeBytes: buffer.length };
}

/**
 * Download binary audio with content-type sniffing.
 * When the API returns JSON (error body despite 200 drift), surfaces the flattened error.
 */
export async function elevenLabsBinaryDownload(
  apiKey: string,
  urlPath: string,
  options: ElevenLabsFetchOptions = {},
): Promise<AudioResult> {
  const response = await elevenLabsFetch(apiKey, urlPath, options);
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const detail = await extractErrorDetail(response);
    throw new ElevenLabsError(
      detail
        ? formatApiErrorMessage('Download failed', detail)
        : 'Download failed: API returned JSON instead of audio',
      'DOWNLOAD_FAILED',
      detail ? getErrorResolution(422, detail) : 'Verify dubbing status with get_dubbing before downloading.',
    );
  }

  const ext = extensionFromContentType(contentType);
  const buffer = Buffer.from(await response.arrayBuffer());
  const fileName = `elevenlabs_${crypto.randomUUID()}.${ext}`;
  const filePath = writeWorkspaceArtifact(fileName, buffer);

  return { filePath, sizeBytes: buffer.length };
}
