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
  REQUEST_TIMEOUT_MS,
  type VisualRequest,
  type VisualStatusResponse,
  type CreateVisualResponse,
} from './types.js';

const NAPKIN_API_BASE = 'https://api.napkin.ai/v1';

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

  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(options.headers as Record<string, string>),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new NapkinError(
        'Request to Napkin API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the Napkin API is available.',
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
 */
export async function downloadFile(
  apiKey: string,
  fileUrl: string,
): Promise<Buffer> {
  let response: Response;

  try {
    response = await fetch(fileUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new NapkinError(
        'Download timed out',
        'TIMEOUT',
        'The download took too long. Try again.',
      );
    }
    throw error;
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
