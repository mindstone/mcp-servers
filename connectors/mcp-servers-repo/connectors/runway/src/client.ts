/**
 * Runway API HTTP client.
 *
 * Centralises Bearer auth + X-Runway-Version header injection,
 * error handling, rate-limit messaging, and timeout handling.
 *
 * Auth: Authorization: Bearer {key}, X-Runway-Version: 2024-11-06
 * Base URL: https://api.dev.runwayml.com/v1
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  RunwayError,
  REQUEST_TIMEOUT_MS,
  RUNWAY_API_BASE,
  RUNWAY_API_VERSION,
  MIME_MAP,
  DATA_URI_BINARY_LIMITS,
  MAX_UPLOAD_BYTES,
  MIN_UPLOAD_BYTES,
  type UploadResponse,
} from './types.js';
import { getApiKey } from './auth.js';

/**
 * Make an authenticated JSON request to the Runway API.
 */
export async function runwayFetch<T>(
  urlPath: string,
  options: RequestInit = {},
): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new RunwayError(
      'Runway API key not configured',
      'AUTH_REQUIRED',
      'Configure your Runway API key in Settings. Get one at https://dev.runwayml.com/',
    );
  }

  const url = `${RUNWAY_API_BASE}${urlPath}`;

  console.error(`[Runway API] ${options.method || 'GET'} ${url}`);

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-Runway-Version': RUNWAY_API_VERSION,
        ...(options.headers as Record<string, string> || {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new RunwayError(
        'Request to Runway API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the Runway API is available.',
      );
    }
    throw error;
  }

  if (response.status === 429) {
    throw new RunwayError('Rate limited.', 'RATE_LIMITED', 'Wait a moment and try again.');
  }
  if (response.status === 401) {
    throw new RunwayError('Authentication failed.', 'AUTH_FAILED', 'Check your Runway API key.');
  }
  if (response.status === 403) {
    throw new RunwayError('Access forbidden.', 'AUTH_FAILED', 'Check your Runway API key and account permissions.');
  }
  if (response.status === 404) {
    throw new RunwayError('Resource not found.', 'NOT_FOUND', 'The resource does not exist or was deleted.');
  }
  if (!response.ok) {
    let detail = '';
    try {
      detail = ((await response.json()) as { error?: string })?.error || '';
    } catch { /* empty */ }
    throw new RunwayError(
      `Runway API error (HTTP ${response.status}): ${detail}`,
      `HTTP_${response.status}`,
      'Try again or check https://dev.runwayml.com/',
    );
  }
  return (await response.json()) as T;
}

/**
 * Make a raw authenticated fetch (for DELETE endpoints that return 204 with no body).
 */
export async function runwayRawFetch(
  urlPath: string,
  options: RequestInit = {},
): Promise<Response> {
  const apiKey = getApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new RunwayError(
      'Runway API key not configured',
      'AUTH_REQUIRED',
      'Configure your Runway API key in Settings. Get one at https://dev.runwayml.com/',
    );
  }

  const url = `${RUNWAY_API_BASE}${urlPath}`;

  console.error(`[Runway API] ${options.method || 'GET'} ${url}`);

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Runway-Version': RUNWAY_API_VERSION,
        ...(options.headers as Record<string, string> || {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new RunwayError(
        'Request to Runway API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the Runway API is available.',
      );
    }
    throw error;
  }

  if (response.status === 429) {
    throw new RunwayError('Rate limited.', 'RATE_LIMITED', 'Wait a moment and try again.');
  }
  if (response.status === 401) {
    throw new RunwayError('Authentication failed.', 'AUTH_FAILED', 'Check your Runway API key.');
  }
  if (response.status === 403) {
    throw new RunwayError('Access forbidden.', 'AUTH_FAILED', 'Check your Runway API key and account permissions.');
  }

  return response;
}

// ============================================================================
// File resolution & ephemeral upload helpers
// ============================================================================

/**
 * Upload a local file to Runway's ephemeral storage.
 * Returns a runway:// URI valid for 24 hours.
 */
export async function uploadEphemeral(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new RunwayError(`File not found: ${filePath}`, 'FILE_NOT_FOUND',
      'Provide an accessible local file path.');
  }
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw new RunwayError(`Not a file: ${filePath}`, 'INVALID_INPUT',
      'Provide a file path, not a directory.');
  }
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new RunwayError('File exceeds 200MB upload limit.', 'FILE_TOO_LARGE',
      'Reduce the file size or use a URL instead.');
  }
  if (stats.size < MIN_UPLOAD_BYTES) {
    throw new RunwayError('File must be at least 512 bytes.', 'FILE_TOO_SMALL',
      'Provide a valid media file.');
  }

  const filename = path.basename(filePath);
  const uploadInfo = await runwayFetch<UploadResponse>('/uploads', {
    method: 'POST',
    body: JSON.stringify({ filename, type: 'ephemeral' }),
  });

  const fileBuffer = fs.readFileSync(filePath);
  const formData = new FormData();
  for (const [key, value] of Object.entries(uploadInfo.fields)) {
    formData.append(key, value);
  }
  formData.append('file', new Blob([fileBuffer]), filename);

  const uploadRes = await fetch(uploadInfo.uploadUrl, { method: 'POST', body: formData });
  if (!uploadRes.ok && uploadRes.status !== 204) {
    throw new RunwayError(`Upload failed (HTTP ${uploadRes.status})`, 'UPLOAD_FAILED',
      'Try again. If the file is too large (max 200MB), reduce its size.');
  }

  return uploadInfo.runwayUri;
}

/**
 * Resolve a media input to a usable URI.
 * - HTTPS/data/runway URIs are passed through.
 * - Local files under the size limit are converted to data URIs.
 * - Large local files are uploaded via ephemeral upload.
 */
export async function resolveMediaInput(
  input: string,
  category: 'image' | 'video' | 'audio',
): Promise<string> {
  if (input.startsWith('https://') || input.startsWith('data:') || input.startsWith('runway://')) {
    return input;
  }

  try {
    const stats = fs.statSync(input);
    if (!stats.isFile()) {
      throw new RunwayError(`Not a file: ${input}`, 'INVALID_INPUT',
        'Provide a file path, not a directory.');
    }
    const limit = DATA_URI_BINARY_LIMITS[category];
    if (stats.size > limit) {
      return await uploadEphemeral(input);
    }
    const buffer = fs.readFileSync(input);
    const ext = input.split('.').pop()?.toLowerCase() || 'bin';
    const fallback = category === 'image' ? 'image/png' : category === 'video' ? 'video/mp4' : 'audio/mpeg';
    const mime = MIME_MAP[ext] || fallback;
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (err) {
    if (err instanceof RunwayError) throw err;
    throw new RunwayError(`Could not read file: ${input}`, 'FILE_NOT_FOUND',
      'Provide a valid HTTPS URL, Runway URI, or accessible local file path.');
  }
}

// ============================================================================
// SSRF / Host validation for download URLs
// ============================================================================

/**
 * Check whether a hostname is private, localhost, or otherwise reserved.
 * Matches the same patterns as Workday's SSRF prevention.
 */
function isPrivateOrReservedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Localhost names
  if (lower === 'localhost' || lower === '[::1]' || lower === '::1') {
    return true;
  }

  // .local domains
  if (lower.endsWith('.local')) {
    return true;
  }

  // IPv4 private/reserved ranges
  const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 127) return true;           // 127.0.0.0/8 loopback
    if (a === 10) return true;            // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0) return true;             // 0.0.0.0/8
  }

  // IPv6 private/loopback (bracket-wrapped from URL parsing)
  if (lower.startsWith('[') && lower.endsWith(']')) {
    const inner = lower.slice(1, -1);
    if (inner === '::1' || inner === '::' || inner.startsWith('fe80:') || inner.startsWith('fc') || inner.startsWith('fd')) {
      return true;
    }
  }

  return false;
}

/**
 * Validate a download URL for SSRF safety.
 * Returns an error message if the URL is unsafe, or null if OK.
 */
export function validateDownloadUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL.';
  }

  if (parsed.protocol !== 'https:') {
    return 'Only HTTPS URLs are supported for download.';
  }

  if (isPrivateOrReservedHost(parsed.hostname)) {
    return 'Cannot download from local/private network addresses.';
  }

  return null;
}

// ============================================================================
// Cost estimation helper
// ============================================================================

export function costEstimate(
  model: string,
  duration: number,
  audio?: boolean,
): { credits: number; usd: string } {
  const rates: Record<string, number> = {
    'gen4.5': 12,
    gen4_turbo: 5,
    gen3a_turbo: 5,
    gen4_aleph: 15,
    act_two: 5,
    veo3: 40,
    'veo3.1': audio === false ? 20 : 40,
    'veo3.1_fast': audio === false ? 10 : 15,
  };
  const credits = (rates[model] || 5) * duration;
  return { credits, usd: `$${(credits * 0.01).toFixed(2)}` };
}

/**
 * Add content moderation to a request body if specified.
 */
export function addContentModeration(body: Record<string, unknown>, contentMod?: string): void {
  if (contentMod === 'low') {
    body.contentModeration = { publicFigureThreshold: 'low' };
  }
}
