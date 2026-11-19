/**
 * Napkin AI API HTTP client.
 *
 * Centralises Bearer auth header injection, error handling, rate-limit
 * messaging, and timeout handling for all Napkin API calls.
 *
 * Auth: Authorization: Bearer {key}
 * Base URL: https://api.napkin.ai/v1
 */

import { z } from 'zod';
import {
  NapkinError,
  getRequestTimeoutMs,
  createVisualResponseSchema,
  visualStatusResponseSchema,
  pathIdSchema,
  type VisualRequest,
  type VisualStatusResponse,
  type CreateVisualResponse,
} from './types.js';
import { wrapUntrusted } from './untrusted-content.js';
import { pathSegment } from './utils.js';

/** Envelope source label for vendor-authored HTTP error text (invariant #6). */
const VENDOR_ERROR_SOURCE = 'napkin-api-error';

const NAPKIN_API_BASE = 'https://api.napkin.ai/v1';

/**
 * Hard-coded allow-list of hosts the connector will download from.
 *
 * `napkin_download_visual` attaches `Authorization: Bearer <NAPKIN_API_KEY>`
 * to its outbound request, so the destination MUST be limited to the
 * official Napkin API host, and `validateDownloadUrl` further limits it to
 * the documented file route. The Napkin API documentation specifies that
 * download URLs are returned by the status endpoint as
 * `https://api.napkin.ai/v1/visual/<request-id>/file/<file-id>` — there is
 * no separate signed-URL CDN host. Keeping this list as a literal const
 * (NOT env-overridable) prevents prompt-injection-driven exfiltration of
 * the API key to attacker-controlled hosts.
 */
export const NAPKIN_DOWNLOAD_ALLOWED_HOSTS: readonly string[] = ['api.napkin.ai'] as const;

/** The only origin a download may reach: the allow-listed host on the default HTTPS port. */
const NAPKIN_DOWNLOAD_ORIGIN = 'https://api.napkin.ai';

/** The documented file route; both IDs must also pass `pathIdSchema`. */
const NAPKIN_FILE_PATH = /^\/v1\/visual\/([^/]+)\/file\/([^/]+)$/;

/** Longest Retry-After we report as a number; anything above reads "at least 5 minutes". */
const MAX_RETRY_AFTER_SECONDS = 300;

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
 * Validate a download URL against the Napkin allow-list and file route.
 *
 * Rejects:
 *  - malformed URLs
 *  - non-HTTPS schemes
 *  - URLs carrying userinfo (`https://user:pass@host/...`)
 *  - hosts outside `NAPKIN_DOWNLOAD_ALLOWED_HOSTS`
 *  - hosts matching private/loopback/link-local/reserved IP ranges
 *  - any origin other than `https://api.napkin.ai` (e.g. another port)
 *  - any query string or fragment, even an empty one
 *  - any path other than `/v1/visual/<request-id>/file/<file-id>`, checked
 *    on the parsed (dot-segment-resolved) path, each ID in the machine-ID
 *    charset (so no `%`-encoded separators)
 *
 * Throws a `NapkinError` (with `URL_REJECTED` code) on any failure. Messages
 * name the rule that failed and never echo the URL or any part of it: a
 * redirect target's URL is server-chosen and can carry signed queries.
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
      'Refusing file_url: the scheme is not https',
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
      'Refusing file_url: the host is a private/loopback/reserved address',
      'URL_REJECTED',
      'file_url must point at the public Napkin API host (api.napkin.ai).',
    );
  }

  if (!NAPKIN_DOWNLOAD_ALLOWED_HOSTS.includes(host)) {
    throw new NapkinError(
      `Refusing file_url: the host is not on the Napkin allow-list (${NAPKIN_DOWNLOAD_ALLOWED_HOSTS.join(', ')})`,
      'URL_REJECTED',
      'Pass a URL returned by napkin_check_status (generated_files[].url). Other hosts are refused to prevent leaking the Napkin API key.',
    );
  }

  if (parsed.origin !== NAPKIN_DOWNLOAD_ORIGIN) {
    throw new NapkinError(
      'Refusing file_url: only the default https port is accepted',
      'URL_REJECTED',
      'Pass a URL returned by napkin_check_status (generated_files[].url) unchanged.',
    );
  }

  // `href` keeps a bare `?` or `#`, which `search` and `hash` report as ''.
  if (parsed.href.includes('?') || parsed.href.includes('#')) {
    throw new NapkinError(
      'Refusing file_url: a query string or fragment is not accepted',
      'URL_REJECTED',
      'Pass a URL returned by napkin_check_status (generated_files[].url) unchanged; Napkin file URLs carry no query or fragment.',
    );
  }

  const route = NAPKIN_FILE_PATH.exec(parsed.pathname);
  if (
    !route ||
    !pathIdSchema.safeParse(route[1]).success ||
    !pathIdSchema.safeParse(route[2]).success
  ) {
    throw new NapkinError(
      'Refusing file_url: the path is not a Napkin file path (/v1/visual/<request-id>/file/<file-id>)',
      'URL_REJECTED',
      'Pass a URL returned by napkin_check_status (generated_files[].url) unchanged. Other Napkin endpoints are refused to prevent sending the API key where it is not needed.',
    );
  }

  return parsed;
}

/**
 * Make an authenticated request to the Napkin API.
 *
 * The response body is validated fail-closed against `schema` before it
 * reaches tool code (AGENTS.md code conventions: validate every external
 * response with Zod). Malformed JSON or a shape mismatch surfaces as a
 * structured INVALID_RESPONSE error — a bare cast would instead let a
 * malformed payload crash downstream with an unstructured TypeError, and
 * raw parser messages can embed fragments of the vendor payload, so they
 * must never reach model-visible output.
 */
async function napkinFetch<S extends z.ZodTypeAny>(
  apiKey: string,
  endpoint: string,
  options: RequestInit,
  schema: S,
): Promise<z.infer<S>> {
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
      // These requests carry the API key, so a redirect is never followed:
      // the key must not travel to a server-chosen target. 'manual' hands
      // the 30x back to us and it is refused below.
      redirect: 'manual',
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

  // Refuse any redirect. The Location header is never read or echoed: it is
  // server-chosen and can carry signed queries.
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {
      /* best-effort drain */
    });
    throw new NapkinError(
      `Napkin's reply was a redirect (HTTP ${response.status}), which is not allowed for requests that carry the API key`,
      'REDIRECT_REJECTED',
      'The request was not sent on to the redirect target. Try again; if the problem persists, check the Napkin status page.',
    );
  }

  // Handle rate limiting. Retry-After is read only as whole seconds and capped;
  // the header text itself never reaches the message.
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After')?.trim() ?? '';
    // Any run of digits: Number() of a huge one is Infinity, which falls into
    // the "at least 5 minutes" branch.
    const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
    const waitTime =
      seconds === 0
        ? 'a moment'
        : seconds > MAX_RETRY_AFTER_SECONDS
          ? 'at least 5 minutes'
          : `${seconds} second${seconds === 1 ? '' : 's'}`;
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
      'Your API key is invalid or does not have permission for this operation. Check it at https://app.napkin.ai → Account Settings → Developers.',
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

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch {
    throw new NapkinError(
      `Napkin API returned an unreadable (non-JSON) response (HTTP ${response.status})`,
      'INVALID_RESPONSE',
      'The Napkin API returned an unexpected response. Try again; if the problem persists, check the Napkin status page.',
    );
  }

  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    // Log only paths and codes — never received values, which can embed
    // fragments of the vendor payload. stderr is not model-visible.
    console.error(
      '[Napkin] Unexpected API response shape:',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
    );
    throw new NapkinError(
      'Napkin API returned an unexpected response shape',
      'INVALID_RESPONSE',
      'The Napkin API response did not match the expected format. Try again; if the problem persists, check the Napkin status page.',
    );
  }

  return parsed.data;
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

  return napkinFetch(apiKey, '/visual', {
    method: 'POST',
    body: JSON.stringify(body),
  }, createVisualResponseSchema);
}

/**
 * Get the status of a visual generation request.
 */
export async function getVisualStatus(
  apiKey: string,
  requestId: string,
): Promise<VisualStatusResponse> {
  return napkinFetch(apiKey, `/visual/${pathSegment(requestId)}/status`, {}, visualStatusResponseSchema);
}

/**
 * Download a file from a URL with Bearer auth.
 * Returns the raw Buffer.
 *
 * The URL is validated by `validateDownloadUrl` (allow-listed host, file
 * route only, no query) BEFORE the
 * `Authorization: Bearer` header is constructed. This is a defence-in-depth
 * measure against prompt-injection-driven API-key exfiltration: if validation
 * fails we throw before composing the header, and the request is never sent.
 *
 * Redirects are NOT auto-followed (AGENTS.md invariant #7): each hop is
 * fetched with `redirect: 'manual'` and every `Location` target is
 * re-validated by `validateDownloadUrl` before it is followed, so a 30x
 * from the API host cannot smuggle the request — and the bytes written to
 * disk — to an internal or attacker-controlled host, or to another endpoint. The Bearer header is
 * only ever attached to a URL that has passed `validateDownloadUrl`.
 */
export async function downloadFile(
  apiKey: string,
  fileUrl: string,
): Promise<Buffer> {
  // Validate FIRST — throws NapkinError on rejection. The Authorization
  // header is intentionally not constructed yet so that any failure path
  // here cannot leak the API key over the wire.
  const validated = validateDownloadUrl(fileUrl);

  const timeoutMs = getRequestTimeoutMs();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  // SSRF-via-redirect defence: `redirect: 'manual'`, re-validate every
  // Location target with the same rules, cap the chain depth.
  const MAX_REDIRECTS = 5;
  let currentUrl = validated.toString();
  let redirectCount = 0;
  let response: Response;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: timeoutSignal,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
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

    if (response.status < 300 || response.status >= 400) {
      break;
    }

    // Drain the redirect body so the connection isn't held open.
    try {
      await response.body?.cancel();
    } catch {
      /* best-effort */
    }

    redirectCount++;
    if (redirectCount > MAX_REDIRECTS) {
      throw new NapkinError(
        `Refused to follow redirect: too many redirects (>${MAX_REDIRECTS})`,
        'REDIRECT_REJECTED',
        'The download URL redirected too many times. Generate a new visual and download promptly.',
      );
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new NapkinError(
        'Refused to follow redirect: the redirect response has no Location header',
        'REDIRECT_REJECTED',
        'The download URL returned an incomplete redirect. Generate a new visual and download promptly.',
      );
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      // Do not echo the Location header: signed query strings must not be
      // copied into model-visible output.
      throw new NapkinError(
        'Refused to follow redirect: the redirect target is not a valid URL',
        'REDIRECT_REJECTED',
        'The download URL returned a malformed redirect. Generate a new visual and download promptly.',
      );
    }

    // Re-apply the same validation (host, route, no query) to every redirect
    // target. The thrown URL_REJECTED message names only the rule that
    // failed — never any part of the Location — so it is safe to relay.
    try {
      validateDownloadUrl(nextUrl);
    } catch (error) {
      if (error instanceof NapkinError) {
        throw new NapkinError(
          `Refused to follow redirect: the redirect target failed safety validation (${error.message})`,
          'REDIRECT_REJECTED',
          'The download URL redirected to a location outside the Napkin safety rules. Only pass URLs returned by napkin_check_status.',
        );
      }
      throw error;
    }

    currentUrl = nextUrl;
  }

  if (response.status === 410) {
    throw new NapkinError(
      'Download URL expired',
      'EXPIRED',
      'Napkin file URLs expire 30 minutes after generation. Call napkin_generate_visual again and download promptly once napkin_check_status returns "completed".',
    );
  }

  if (!response.ok) {
    // The HTTP reason phrase is vendor-controlled free text — envelope it so
    // it reaches model-visible output as data, not instructions.
    throw new NapkinError(
      `Download failed (HTTP ${response.status}): ${wrapUntrusted(response.statusText, VENDOR_ERROR_SOURCE) ?? ''}`,
      'DOWNLOAD_ERROR',
      'The download URL may have expired. Generate a new visual and download promptly.',
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
