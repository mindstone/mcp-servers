/**
 * Gamma API HTTP client.
 *
 * Centralises x-api-key header injection, error handling, rate-limit
 * messaging, and timeout handling for all Gamma API calls.
 *
 * Auth: x-api-key: {key}
 * Base URL: https://public-api.gamma.app/v1.0
 */

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
 * Make an authenticated request to the Gamma API.
 */
async function gammaFetch<T>(
  apiKey: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
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

  // Handle rate limiting
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const waitTime = retryAfter ? `${retryAfter} seconds` : 'a moment';
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
    const errorText = await response.text().catch(() => '');
    console.error(`Gamma API error (${response.status}):`, errorText);

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

  return response.json() as Promise<T>;
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

  return gammaFetch<GenerationResponse>(apiKey, '/generations', {
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

  return gammaFetch<GenerationResponse>(apiKey, '/generations/from-template', {
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
  return gammaFetch<GenerationStatus>(apiKey, `/generations/${generationId}`);
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
  return gammaFetch<PaginatedResponse<Theme>>(
    apiKey,
    `/themes${queryString ? `?${queryString}` : ''}`,
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
  return gammaFetch<PaginatedResponse<Folder>>(
    apiKey,
    `/folders${queryString ? `?${queryString}` : ''}`,
  );
}

/**
 * Download an export file (PDF/PPTX) to the system tmpdir.
 * Returns the absolute path of the downloaded file.
 *
 * The URL is validated against the Gamma export allow-list BEFORE any outbound
 * request is made — a rejected URL produces a structured `URL_REJECTED` error
 * with zero network calls.
 */
export async function downloadExportFile(
  url: string,
  generationId: string,
  format: 'pdf' | 'pptx',
): Promise<string> {
  const validated = validateDownloadUrl(url);

  const { writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');

  const safeId = generationId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `gamma_export_${safeId}_${Date.now()}.${format}`;
  const filePath = join(tmpdir(), fileName);

  const response = await fetch(validated.toString());
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(filePath, buffer);
  return filePath;
}
