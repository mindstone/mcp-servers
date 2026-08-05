/**
 * Napkin AI API HTTP client.
 *
 * Centralises Bearer auth header injection, error handling, rate-limit
 * messaging, and timeout handling for all Napkin API calls.
 *
 * Auth: Authorization: Bearer {key}
 * Base URL: https://api.napkin.ai/v1
 */

import {
  NapkinError,
  getRequestTimeoutMs,
  type VisualRequest,
  type VisualStatusResponse,
  type CreateVisualResponse,
} from './types.js';

const NAPKIN_API_BASE = 'https://api.napkin.ai/v1';

/**
 * Hard-coded allow-list of hosts the connector will download from.
 *
 * `napkin_download_visual` attaches `Authorization: Bearer <NAPKIN_API_KEY>`
 * to its outbound request, so the destination MUST be limited to the
 * official Napkin API host. The Napkin API documentation specifies that
 * download URLs are returned by the status endpoint as
 * `https://api.napkin.ai/v1/visual/<request-id>/file/<file-id>` — there is
 * no separate signed-URL CDN host. Keeping this list as a literal const
 * (NOT env-overridable) prevents prompt-injection-driven exfiltration of
 * the API key to attacker-controlled hosts.
 */
export const NAPKIN_DOWNLOAD_ALLOWED_HOSTS: readonly string[] = ['api.napkin.ai'] as const;

/**
 * Check whether a hostname is private, localhost, or otherwise reserved.
 * Defence-in-depth check on top of the allow-list — even if a future
 * allow-list entry resolved to a private IP literal in `file_url`, this
 * blocks SSRF-style attempts.
 */
function isPrivateOrReservedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  if (lower === 'localhost' || lower === '[::1]' || lower === '::1') {
    return true;
  }

  if (lower.endsWith('.local')) {
    return true;
  }

  // IPv4 private/reserved ranges
  const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 127) return true;            // 127.0.0.0/8 loopback
    if (a === 10) return true;             // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0) return true;              // 0.0.0.0/8
  }

  // IPv6 loopback / unique-local / link-local (URL parsing wraps in [])
  if (lower.startsWith('[') && lower.endsWith(']')) {
    const inner = lower.slice(1, -1);
    if (inner === '::1' || inner === '::' || inner.startsWith('fe80:') || inner.startsWith('fc') || inner.startsWith('fd')) {
      return true;
    }
  }

  return false;
}

/**
 * Validate a download URL against the Napkin allow-list.
 *
 * Rejects:
 *  - malformed URLs
 *  - non-HTTPS schemes
 *  - URLs carrying userinfo (`https://user:pass@host/...`)
 *  - hosts outside `NAPKIN_DOWNLOAD_ALLOWED_HOSTS`
 *  - hosts matching private/loopback/link-local/reserved IP ranges
 *
 * Throws a `NapkinError` (with `URL_REJECTED` code) on any failure.
 * Callers MUST invoke this BEFORE constructing the `Authorization` header.
 */
export function validateDownloadUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new NapkinError(
      'Invalid file_url',
      'URL_REJECTED',
      'file_url must be a valid URL returned by Napkin (generated_files[].url).',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new NapkinError(
      `Refusing non-HTTPS file_url scheme '${parsed.protocol.replace(/:$/, '')}'`,
      'URL_REJECTED',
      'Only https:// URLs are accepted for napkin_download_visual.',
    );
  }

  if (parsed.username || parsed.password) {
    throw new NapkinError(
      'Refusing file_url containing userinfo (user:pass@host)',
      'URL_REJECTED',
      'Strip userinfo from the URL; only plain Napkin-hosted https URLs are accepted.',
    );
  }

  const host = parsed.hostname.toLowerCase();

  if (isPrivateOrReservedHost(parsed.hostname)) {
    throw new NapkinError(
      `Refusing file_url whose host '${parsed.hostname}' is a private/loopback/reserved address`,
      'URL_REJECTED',
      'file_url must point at the public Napkin API host (api.napkin.ai).',
    );
  }

  if (!NAPKIN_DOWNLOAD_ALLOWED_HOSTS.includes(host)) {
    throw new NapkinError(
      `Refusing file_url host '${parsed.hostname}': not on the Napkin allow-list (${NAPKIN_DOWNLOAD_ALLOWED_HOSTS.join(', ')})`,
      'URL_REJECTED',
      'Pass a URL returned by napkin_check_status (generated_files[].url). Other hosts are refused to prevent leaking the Napkin API key.',
    );
  }

  return parsed;
}

/**
 * Make an authenticated request to the Napkin API.
 */
async function napkinFetch<T>(
  apiKey: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${NAPKIN_API_BASE}${endpoint}`;

  console.error(`[Napkin API] ${options.method || 'GET'} ${url}`);

  let response: Response;

  const timeoutMs = getRequestTimeoutMs();
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
        Authorization: `Bearer ${apiKey}`,
        ...(options.headers as Record<string, string>),
      },
    });
  } catch (error) {
    // Attribute timeout to OUR signal only (not any caller-supplied TimeoutError):
    // timeoutSignal.aborted goes true iff its timer actually expired. If the caller
    // aborted first, their AbortError rethrows unchanged.
    if (timeoutSignal.aborted) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      throw new NapkinError(
        `Request to Napkin API timed out after ${timeoutSec}s`,
        'TIMEOUT',
        `The request took longer than ${timeoutSec}s. Set NAPKIN_REQUEST_TIMEOUT_MS to increase the timeout, or try again.`,
      );
    }
    throw error;
  }

  // Handle rate limiting
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const waitTime = retryAfter ? `${retryAfter} seconds` : 'a moment';
    throw new NapkinError(
      `Rate limited. Please wait ${waitTime} before retrying.`,
      'RATE_LIMITED',
      `Wait ${waitTime} and try again.`,
    );
  }

  // Handle auth errors
  if (response.status === 401) {
    throw new NapkinError(
      'Authentication failed',
      'AUTH_FAILED',
      'API key is invalid or revoked. Check your Napkin API key at https://app.napkin.ai → Account Settings → Developers.',
    );
  }

  if (response.status === 403) {
    throw new NapkinError(
      'Access forbidden',
      'AUTH_FAILED',
      'Your API key does not have permission for this operation.',
    );
  }

  // Handle not found
  if (response.status === 404) {
    throw new NapkinError(
      'Resource not found',
      'NOT_FOUND',
      'The requested resource does not exist. Check the ID and try again.',
    );
  }

  // Handle expired resources — Napkin status/file URLs expire 30 minutes
  // after generation (documented 410 on the status endpoint).
  if (response.status === 410) {
    throw new NapkinError(
      'Resource expired',
      'EXPIRED',
      'Napkin request status expires 30 minutes after generation. Start over with napkin_generate_visual, then poll napkin_check_status and download promptly.',
    );
  }

  // Handle other errors
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    console.error(`Napkin API error (${response.status}):`, errorText);

    const statusMessage =
      response.status === 422
        ? 'Validation error - check request parameters'
        : response.status >= 500
          ? 'Napkin server error - try again later'
          : 'Request failed';

    throw new NapkinError(
      `Napkin API error (${response.status}): ${statusMessage}`,
      'API_ERROR',
      'Check the request parameters and try again.',
    );
  }

  return response.json() as Promise<T>;
}

/**
 * Create a new visual generation request.
 */
export async function createVisual(
  apiKey: string,
  req: VisualRequest,
): Promise<CreateVisualResponse> {
  const body: Record<string, unknown> = {
    content: req.content,
    format: req.format ?? 'svg',
  };

  if (req.language) body.language = req.language;
  if (req.context) body.context = req.context;
  if (req.style_id) body.style_id = req.style_id;
  if (req.visual_query) body.visual_query = req.visual_query;
  if (req.visual_queries) body.visual_queries = req.visual_queries;
  if (req.visual_id) body.visual_id = req.visual_id;
  if (req.visual_ids) body.visual_ids = req.visual_ids;
  if (req.transparent_background !== undefined) body.transparent_background = req.transparent_background;
  if (req.color_mode) body.color_mode = req.color_mode;
  if (req.number_of_visuals) body.number_of_visuals = req.number_of_visuals;
  if (req.orientation) body.orientation = req.orientation;
  if (req.text_extraction_mode) body.text_extraction_mode = req.text_extraction_mode;
  if (req.sort_strategy) body.sort_strategy = req.sort_strategy;
  if (req.width) body.width = req.width;
  if (req.height) body.height = req.height;

  return napkinFetch<CreateVisualResponse>(apiKey, '/visual', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Get the status of a visual generation request.
 */
export async function getVisualStatus(
  apiKey: string,
  requestId: string,
): Promise<VisualStatusResponse> {
  return napkinFetch<VisualStatusResponse>(apiKey, `/visual/${requestId}/status`);
}

/**
 * Download a file from a URL with Bearer auth.
 * Returns the raw Buffer.
 *
 * The URL is validated against `NAPKIN_DOWNLOAD_ALLOWED_HOSTS` BEFORE the
 * `Authorization: Bearer` header is constructed. This is a defence-in-depth
 * measure against prompt-injection-driven API-key exfiltration: if validation
 * fails we throw before composing the header, and the request is never sent.
 */
export async function downloadFile(
  apiKey: string,
  fileUrl: string,
): Promise<Buffer> {
  // Validate FIRST — throws NapkinError on rejection. The Authorization
  // header is intentionally not constructed yet so that any failure path
  // here cannot leak the API key over the wire.
  const validated = validateDownloadUrl(fileUrl);

  let response: Response;

  const timeoutMs = getRequestTimeoutMs();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  // Only NOW (after validation) build the request init that carries the
  // Bearer token, and issue the request.
  const requestUrl = validated.toString();
  const requestInit: RequestInit = {
    signal: timeoutSignal,
    headers: { Authorization: `Bearer ${apiKey}` },
  };

  try {
    response = await fetch(requestUrl, requestInit);
  } catch (error) {
    // Download path has no caller signal, so timeoutSignal.aborted is unambiguous.
    if (timeoutSignal.aborted) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      throw new NapkinError(
        `Download timed out after ${timeoutSec}s`,
        'TIMEOUT',
        `The download took longer than ${timeoutSec}s. Set NAPKIN_REQUEST_TIMEOUT_MS to increase the timeout, or try again.`,
      );
    }
    throw error;
  }

  if (response.status === 410) {
    throw new NapkinError(
      'Download URL expired',
      'EXPIRED',
      'Napkin file URLs expire 30 minutes after generation. Call napkin_generate_visual again and download promptly once napkin_check_status returns "completed".',
    );
  }

  if (!response.ok) {
    throw new NapkinError(
      `Download failed (HTTP ${response.status}): ${response.statusText}`,
      'DOWNLOAD_ERROR',
      'The download URL may have expired. Generate a new visual and download promptly.',
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
