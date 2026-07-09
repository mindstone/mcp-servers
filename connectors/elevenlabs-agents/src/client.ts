/**
 * ElevenLabs Conversational AI HTTP client.
 *
 * Centralises xi-api-key header injection, error handling, timeout plumbing,
 * and binary download handling for the agents connector.
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
import { ELEVENLABS_API_V1_BASE } from './endpoints.js';
import { envelopeApiErrorDetail, formatApiErrorMessage } from './error-detail.js';
import { getApiKey } from './auth.js';

export interface ElevenLabsFetchOptions extends RequestInit {
  /** Per-call timeout override (default REQUEST_TIMEOUT_MS). Explicit `signal` wins. */
  timeoutMs?: number;
}

export function requireApiKey(): string {
  const apiKey = getApiKey().trim();
  if (!apiKey) {
    throw new ElevenLabsError(
      'ElevenLabs API key not configured',
      'AUTH_REQUIRED',
      'Configure your ElevenLabs API key in Settings. Get one at https://elevenlabs.io/app/settings/api-keys',
    );
  }
  return apiKey;
}

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

  if (!(fetchOptions.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  console.error(`[ElevenLabs Agents API] ${fetchOptions.method || 'GET'} ${url}`);

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

  if (response.status === 429) {
    throw new ElevenLabsError(
      'Rate limited. Please wait a moment before retrying.',
      'RATE_LIMITED',
      getErrorResolution(429),
    );
  }

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
        ? 'Regenerate your API key at https://elevenlabs.io/app/settings/api-keys with the missing Conversational AI permission enabled, then call configure_elevenlabs_agents_api_key again.'
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

export async function extractErrorDetail(response: Response): Promise<string> {
  try {
    const errBody = (await response.clone().json()) as unknown;
    const d = (errBody as { detail?: unknown; error?: unknown; message?: unknown } | null);
    const detail = d?.detail ?? d?.error ?? d?.message;
    if (detail == null) return '';
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      const parts = detail
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return '';
          const item = entry as { loc?: unknown; msg?: unknown; type?: unknown };
          const loc = Array.isArray(item.loc) ? item.loc.join('.') : '';
          const msg = typeof item.msg === 'string'
            ? item.msg
            : typeof item.type === 'string'
              ? item.type
              : 'invalid';
          return loc ? `${loc}: ${msg}` : msg;
        })
        .filter((part) => part.length > 0);
      return parts.join('; ');
    }
    if (typeof detail === 'object') {
      const obj = detail as { message?: unknown; status?: unknown; cause?: unknown };
      const parts: string[] = [];
      if (typeof obj.status === 'string') parts.push(obj.status);
      if (typeof obj.message === 'string') parts.push(obj.message);
      if (typeof obj.cause === 'string') parts.push(`cause: ${obj.cause}`);
      return parts.join(' — ');
    }
    return '';
  } catch {
    return '';
  }
}

export async function elevenLabsJson<T>(
  apiKey: string,
  urlPath: string,
  options: ElevenLabsFetchOptions = {},
): Promise<T> {
  const response = await elevenLabsFetch(apiKey, urlPath, options);
  return (await response.json()) as T;
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
    'application/octet-stream': 'bin',
  };
  return map[ct] ?? 'mp3';
}

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
      detail ? getErrorResolution(422, detail) : 'Verify the conversation exists and has audio before retrying.',
    );
  }

  const ext = extensionFromContentType(contentType);
  const buffer = Buffer.from(await response.arrayBuffer());
  const fileName = `elevenlabs_agents_${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(os.tmpdir(), fileName);
  fs.writeFileSync(filePath, buffer);

  return { filePath, sizeBytes: buffer.length };
}
