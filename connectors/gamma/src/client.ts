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
 */
export async function downloadExportFile(
  url: string,
  generationId: string,
  format: 'pdf' | 'pptx',
): Promise<string> {
  const { writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');

  const safeId = generationId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `gamma_export_${safeId}_${Date.now()}.${format}`;
  const filePath = join(tmpdir(), fileName);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(filePath, buffer);
  return filePath;
}
