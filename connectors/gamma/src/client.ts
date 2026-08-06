/**
 * Gamma API HTTP client.
 *
 * Centralises x-api-key header injection, error handling, rate-limit
 * messaging, and timeout handling for all Gamma API calls.
 *
 * Auth: x-api-key: {key}
 * Base URL: https://public-api.gamma.app/v1.0
 */

import { z } from 'zod';
import {
  GammaError,
  getRequestTimeoutMs,
  type GenerationRequest,
  type CreateFromTemplateRequest,
  type GenerationResponse,
  type GenerationStatus,
  type Theme,
  type Folder,
  type PaginatedResponse,
} from './types.js';

const GAMMA_API_BASE = 'https://public-api.gamma.app/v1.0';

// ---------------------------------------------------------------------------
// Response schemas — every Gamma API response is validated fail-closed with
// Zod before it reaches tool code. Unknown vendor-added fields are stripped
// (Zod default), so a poisoned or evolving payload cannot smuggle
// structural-looking fields through the object spreads in the listing tools.
// ---------------------------------------------------------------------------

/**
 * Gamma-issued generation IDs are server-assigned opaque identifiers, but the
 * connector interpolates them into trusted prose and request paths — so they
 * must be strictly shaped rather than `z.string()`: URL-safe identifier
 * characters only, bounded length. A Gamma response carrying anything else
 * fails closed as INVALID_RESPONSE instead of reaching model-visible output
 * (AGENTS.md invariant #6: Gamma-controlled text is untrusted until it is
 * proven to be structured data).
 */
const generationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const generationResponseSchema = z.object({
  generationId: generationIdSchema,
});

const generationStatusSchema = z.object({
  generationId: generationIdSchema,
  status: z.enum(['pending', 'completed', 'failed']),
  gammaUrl: z.string().optional(),
  pdfUrl: z.string().optional(),
  pptxUrl: z.string().optional(),
  credits: z.object({ deducted: z.number(), remaining: z.number() }).optional(),
  error: z.string().optional(),
});

const themeSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['standard', 'custom']),
  colorKeywords: z.array(z.string()).optional(),
  toneKeywords: z.array(z.string()).optional(),
});

const folderSchema = z.object({
  id: z.string(),
  name: z.string(),
});

function paginatedSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable().default(null),
  });
}

/**
 * Hosts allowed to serve export downloads. Export URLs come from Gamma's own
 * API responses (`pdfUrl` / `pptxUrl` in the status payload), but a poisoned or
 * compromised payload must not be able to point the connector's outbound fetch
 * at an arbitrary host (SSRF) or a plaintext endpoint. Gamma-controlled hosts
 * only; deliberately hard-coded, not env-overridable. Subdomains allowed
 * (`public-api.gamma.app`, CDN subdomains); lookalikes such as
 * `gamma.app.evil.example` or `evilgamma.app` are rejected.
 */
const GAMMA_EXPORT_ALLOWED_HOST = 'gamma.app';

function isAllowedExportHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === GAMMA_EXPORT_ALLOWED_HOST || host.endsWith(`.${GAMMA_EXPORT_ALLOWED_HOST}`);
}

/**
 * True for loopback, private, link-local, and reserved IP literals (and
 * localhost-style names) that an export URL must never resolve to.
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
 * Validate an export download URL before any outbound request is made.
 *
 * Rejects:
 *  - malformed URLs
 *  - non-HTTPS schemes
 *  - URLs carrying userinfo (`https://user:pass@host/...`)
 *  - hosts outside the Gamma allow-list (`gamma.app` and subdomains)
 *  - hosts matching private/loopback/link-local/reserved IP ranges
 *
 * Throws a `GammaError` (with `URL_REJECTED` code) on any failure. Mirrors
 * napkin's `validateDownloadUrl`.
 */
export function validateDownloadUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new GammaError(
      'Invalid export URL',
      'URL_REJECTED',
      'The export URL must be a valid URL returned by the Gamma API (pdfUrl / pptxUrl in the status payload).',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new GammaError(
      `Refusing non-HTTPS export URL scheme '${parsed.protocol.replace(/:$/, '')}'`,
      'URL_REJECTED',
      'Only https:// URLs are accepted for export downloads.',
    );
  }

  if (parsed.username || parsed.password) {
    throw new GammaError(
      'Refusing export URL containing userinfo (user:pass@host)',
      'URL_REJECTED',
      'Strip userinfo from the URL; only plain Gamma-hosted https URLs are accepted.',
    );
  }

  if (isPrivateOrReservedHost(parsed.hostname)) {
    throw new GammaError(
      `Refusing export URL whose host '${parsed.hostname}' is a private/loopback/reserved address`,
      'URL_REJECTED',
      'Export URLs must point at a public Gamma host.',
    );
  }

  if (!isAllowedExportHost(parsed.hostname)) {
    throw new GammaError(
      `Refusing export URL host '${parsed.hostname}': not on the Gamma allow-list (${GAMMA_EXPORT_ALLOWED_HOST} and subdomains)`,
      'URL_REJECTED',
      'Export URLs must come from the Gamma API status payload. Other hosts are refused to prevent the connector fetching arbitrary URLs.',
    );
  }

  return parsed;
}

/**
 * Upper bound on an honoured Retry-After delay (seconds). Anything larger is
 * treated as absent rather than relayed, so a hostile or buggy value cannot
 * produce absurd model-visible instructions.
 */
const MAX_RETRY_AFTER_SECONDS = 3600;

// RFC 9110 delay-seconds form: a non-negative decimal integer.
const RETRY_AFTER_DELAY_SECONDS = /^\d{1,10}$/;
// IMF-fixdate, the HTTP-date format in common use: "Sun, 06 Nov 1994 08:49:37 GMT".
const RETRY_AFTER_HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a Gamma-supplied `Retry-After` header into a bounded number of seconds.
 * Returns `undefined` for anything that is not a delay-seconds value or a valid
 * future HTTP-date within the bound.
 *
 * The header is Gamma-controlled external text: the raw value must never be
 * interpolated into model-visible output. Callers build their message from the
 * parsed number, or from a connector-authored phrase when undefined.
 */
export function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (RETRY_AFTER_DELAY_SECONDS.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined;
  }
  if (RETRY_AFTER_HTTP_DATE.test(trimmed)) {
    const seconds = Math.ceil((Date.parse(trimmed) - Date.now()) / 1000);
    if (seconds > 0 && seconds <= MAX_RETRY_AFTER_SECONDS) return seconds;
  }
  return undefined;
}

/**
 * Make an authenticated request to the Gamma API.
 *
 * The response body is parsed defensively and validated against `schema`
 * (fail-closed): a malformed JSON body or a shape mismatch surfaces as a
 * generic `INVALID_RESPONSE` error — raw parser messages can embed a fragment
 * of the vendor response and must never reach model-visible output.
 */
async function gammaFetch<T extends z.ZodTypeAny>(
  apiKey: string,
  endpoint: string,
  schema: T,
  options: RequestInit = {},
): Promise<z.infer<T>> {
  const url = `${GAMMA_API_BASE}${endpoint}`;

  console.error(`[Gamma API] ${options.method || 'GET'} ${url}`);

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
        'x-api-key': apiKey,
        ...(options.headers as Record<string, string>),
      },
    });
  } catch (error) {
    // Attribute timeout to OUR signal only (not any caller-supplied TimeoutError):
    // timeoutSignal.aborted goes true iff its timer actually expired. If the caller
    // aborted first, their AbortError rethrows unchanged.
    if (timeoutSignal.aborted) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      throw new GammaError(
        `Request to Gamma API timed out after ${timeoutSec}s`,
        'TIMEOUT',
        `The request took longer than ${timeoutSec}s. Set GAMMA_REQUEST_TIMEOUT_MS to increase the timeout, or try again.`,
      );
    }
    throw error;
  }

  // Handle rate limiting. The Retry-After header is Gamma-controlled external
  // text: it is parsed into a bounded delay and never interpolated raw, so a
  // hostile header cannot inject instruction-shaped text into the error.
  if (response.status === 429) {
    const retrySeconds = parseRetryAfterSeconds(response.headers.get('Retry-After'));
    const waitTime = retrySeconds !== undefined ? `${retrySeconds} seconds` : 'a moment';
    throw new GammaError(
      `Rate limited. Please wait ${waitTime} before retrying.`,
      'RATE_LIMITED',
      `Wait ${waitTime} and try again.`,
    );
  }

  // Handle auth errors
  if (response.status === 401) {
    throw new GammaError(
      'Authentication failed',
      'AUTH_FAILED',
      'API key is invalid or revoked. Check your Gamma API key at https://gamma.app/settings/developers.',
    );
  }

  if (response.status === 403) {
    throw new GammaError(
      'Access forbidden',
      'AUTH_FAILED',
      'Your API key does not have permission for this operation.',
    );
  }

  // Handle not found
  if (response.status === 404) {
    throw new GammaError(
      'Resource not found',
      'NOT_FOUND',
      'The requested resource does not exist. Check the ID and try again.',
    );
  }

  // Handle other errors
  if (!response.ok) {
    // Deliberately do NOT read or log the vendor error body: it can contain
    // reflected request data, sensitive diagnostics, or attacker-controlled
    // content, and must stay out of both logs and model-visible errors.
    console.error(`Gamma API error: HTTP ${response.status}`);

    const statusMessage =
      response.status === 422
        ? 'Validation error - check request parameters'
        : response.status >= 500
          ? 'Gamma server error - try again later'
          : 'Request failed';

    throw new GammaError(
      `Gamma API error (${response.status}): ${statusMessage}`,
      'API_ERROR',
      'Check the request parameters and try again.',
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GammaError(
      `Gamma API returned a malformed response (HTTP ${response.status})`,
      'INVALID_RESPONSE',
      'The Gamma API response could not be parsed. Try again; if it persists, check the connector logs.',
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    console.error(
      `[Gamma API] Response failed schema validation for ${options.method || 'GET'} ${endpoint} (${parsed.error.issues.length} issue(s))`,
    );
    throw new GammaError(
      'Gamma API returned an unexpected response shape',
      'INVALID_RESPONSE',
      'The Gamma API response did not match the expected schema. If this persists, the API may have changed — check for a connector update.',
    );
  }

  return parsed.data;
}

/**
 * Create a new generation.
 */
export async function createGeneration(
  apiKey: string,
  request: GenerationRequest,
): Promise<GenerationResponse> {
  const body: Record<string, unknown> = {
    inputText: request.inputText,
    textMode: request.textMode || 'generate',
    format: request.format || 'presentation',
  };

  if (request.themeId) body.themeId = request.themeId;
  if (request.numCards) body.numCards = request.numCards;
  if (request.cardSplit) body.cardSplit = request.cardSplit;
  if (request.additionalInstructions) body.additionalInstructions = request.additionalInstructions;
  if (request.folderIds) body.folderIds = request.folderIds;
  if (request.exportAs) body.exportAs = request.exportAs;
  if (request.textOptions) body.textOptions = request.textOptions;
  if (request.imageOptions) body.imageOptions = request.imageOptions;
  if (request.cardOptions) body.cardOptions = request.cardOptions;
  if (request.sharingOptions) body.sharingOptions = request.sharingOptions;

  return gammaFetch(apiKey, '/generations', generationResponseSchema, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Create from an existing template.
 */
export async function createFromTemplate(
  apiKey: string,
  request: CreateFromTemplateRequest,
): Promise<GenerationResponse> {
  const body: Record<string, unknown> = {
    gammaId: request.gammaId,
  };

  if (request.prompt) body.prompt = request.prompt;
  if (request.themeId) body.themeId = request.themeId;
  if (request.folderIds) body.folderIds = request.folderIds;
  if (request.exportAs) body.exportAs = request.exportAs;
  if (request.imageOptions) body.imageOptions = request.imageOptions;
  if (request.sharingOptions) body.sharingOptions = request.sharingOptions;

  return gammaFetch(apiKey, '/generations/from-template', generationResponseSchema, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Get generation status (including export URLs when available).
 */
export async function getGenerationStatus(
  apiKey: string,
  generationId: string,
): Promise<GenerationStatus> {
  // Fail closed on caller-supplied ids before they reach a request path.
  generationIdSchema.parse(generationId);
  return gammaFetch(apiKey, `/generations/${generationId}`, generationStatusSchema);
}

/**
 * List available themes.
 */
export async function listThemes(
  apiKey: string,
  options?: { query?: string; limit?: number; after?: string },
): Promise<PaginatedResponse<Theme>> {
  const params = new URLSearchParams();
  if (options?.query) params.set('query', options.query);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.after) params.set('after', options.after);
  const queryString = params.toString();
  return gammaFetch(
    apiKey,
    `/themes${queryString ? `?${queryString}` : ''}`,
    paginatedSchema(themeSchema),
  );
}

/**
 * List workspace folders.
 */
export async function listFolders(
  apiKey: string,
  options?: { query?: string; limit?: number; after?: string },
): Promise<PaginatedResponse<Folder>> {
  const params = new URLSearchParams();
  if (options?.query) params.set('query', options.query);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.after) params.set('after', options.after);
  const queryString = params.toString();
  return gammaFetch(
    apiKey,
    `/folders${queryString ? `?${queryString}` : ''}`,
    paginatedSchema(folderSchema),
  );
}

/** Maximum redirect hops an export download will follow. */
const MAX_DOWNLOAD_REDIRECTS = 5;

/**
 * Download an export file (PDF/PPTX) to the system tmpdir.
 * Returns the absolute path of the downloaded file.
 *
 * The URL is validated against the Gamma export allow-list BEFORE any outbound
 * request is made — a rejected URL produces a structured `URL_REJECTED` error
 * with zero network calls. Redirects are followed manually with every hop
 * re-validated against the same allow-list, so an allowed export URL cannot
 * bounce the connector's fetch to an arbitrary or private host (SSRF).
 *
 * The temp file is created atomically: opened with O_CREAT|O_EXCL|O_NOFOLLOW
 * (an unpredictable random suffix makes pre-creation impractical, and a raced
 * or pre-planted symlink fails the open instead of being written through),
 * fstat-verified as a regular file, and written through the open descriptor.
 */
export async function downloadExportFile(
  url: string,
  generationId: string,
  format: 'pdf' | 'pptx',
): Promise<string> {
  // Follow redirects manually, re-validating every hop. Invariant #7: do not
  // auto-follow redirects on downloads.
  let current = validateDownloadUrl(url);
  let response: Response | undefined;
  let redirectCount = 0;
  for (;;) {
    response = await fetch(current.toString(), { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      // Drain the redirect body so the connection isn't held open.
      try {
        await response.body?.cancel();
      } catch {
        /* best-effort */
      }
      redirectCount++;
      if (redirectCount > MAX_DOWNLOAD_REDIRECTS) {
        throw new GammaError(
          `Refused to follow redirect: too many redirects (>${MAX_DOWNLOAD_REDIRECTS})`,
          'URL_REJECTED',
          'The export URL redirected too many times. Export manually from the Gamma app instead.',
        );
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new GammaError(
          `Export download redirected (HTTP ${response.status}) without a Location header`,
          'DOWNLOAD_FAILED',
          'The export endpoint responded with an incomplete redirect. Export manually from the Gamma app instead.',
        );
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new GammaError(
          'Refused to follow redirect: invalid Location header',
          'URL_REJECTED',
          'The export endpoint returned a malformed redirect target. Export manually from the Gamma app instead.',
        );
      }
      // Re-validate every hop: a redirect must not downgrade to http://,
      // leave the Gamma allow-list, or point at a private/reserved host.
      // Throws URL_REJECTED on any violation.
      current = validateDownloadUrl(next.toString());
      continue;
    }
    break;
  }

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  const fs = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  const { randomBytes } = await import('crypto');

  const safeId = generationId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `gamma_export_${safeId}_${Date.now()}_${randomBytes(4).toString('hex')}.${format}`;
  const filePath = join(tmpdir(), fileName);

  const buffer = Buffer.from(await response.arrayBuffer());

  // O_NOFOLLOW is unavailable on some platforms (e.g. Windows); O_EXCL alone
  // still refuses any pre-existing path, including symlinks.
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);

  let fd: number;
  try {
    fd = fs.openSync(filePath, flags, 0o600);
  } catch (openErr) {
    const e = openErr as NodeJS.ErrnoException;
    throw new GammaError(
      `Could not create the export temp file (${e?.code || 'unknown error'})`,
      'DOWNLOAD_FAILED',
      'The temporary export path already exists or is not writable. Try again.',
    );
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new GammaError(
        'Export temp file is not a regular file',
        'DOWNLOAD_FAILED',
        'The temporary export path resolved to an unexpected file type. Try again.',
      );
    }
    fs.writeFileSync(fd, buffer);
  } catch (writeErr) {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* cleanup best-effort */
    }
    throw writeErr;
  }
  fs.closeSync(fd);
  return filePath;
}
