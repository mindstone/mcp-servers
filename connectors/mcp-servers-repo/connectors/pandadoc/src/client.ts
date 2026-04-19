/**
 * PandaDoc API HTTP client.
 *
 * Centralises API-Key header injection, error handling, and rate-limit
 * messaging for all PandaDoc API calls.
 *
 * IMPORTANT: PandaDoc uses `Authorization: API-Key {key}` — not Bearer.
 */

import { getApiKey } from './auth.js';
import { PandaDocError, PANDADOC_API_BASE, REQUEST_TIMEOUT_MS } from './types.js';

/**
 * Make an authenticated request to the PandaDoc API.
 *
 * @param path  API path relative to base, e.g. `/documents`
 * @param options  Additional fetch options
 * @returns Parsed JSON response
 */
export async function pandadocFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const key = getApiKey();
  if (!key) {
    throw new PandaDocError(
      'PandaDoc API key not configured',
      'AUTH_REQUIRED',
      'Use configure_pandadoc_api_key to set your API key first.',
    );
  }

  const url = `${PANDADOC_API_BASE}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `API-Key ${key}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new PandaDocError(
        'Request to PandaDoc API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the PandaDoc API is available.',
      );
    }
    throw error;
  }

  if (response.status === 401 || response.status === 403) {
    throw new PandaDocError(
      'Authentication failed',
      'AUTH_FAILED',
      'Your PandaDoc API key is invalid or revoked. Use configure_pandadoc_api_key to set a new key.',
    );
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
    const waitSeconds = Number.isFinite(parsed) ? parsed : 60;
    throw new PandaDocError(
      `Rate limited by PandaDoc API. Please wait ${waitSeconds} seconds before retrying.`,
      'RATE_LIMITED',
      `Wait ${waitSeconds} seconds and try again. PandaDoc has per-minute rate limits.`,
    );
  }

  if (response.status === 404) {
    throw new PandaDocError(
      'Resource not found',
      'NOT_FOUND',
      'The requested document or template does not exist. Verify the ID using list_documents or list_templates.',
    );
  }

  if (response.status === 409) {
    const errorBody = await response.text().catch(() => '');
    throw new PandaDocError(
      `Conflict (409): ${errorBody || 'Document is not ready for this operation.'}`,
      'CONFLICT',
      'Check the document status with get_document_status. The document may not be in the required state.',
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new PandaDocError(
      `PandaDoc API error (${response.status}): ${errorText}`,
      'API_ERROR',
      'Check the request parameters and try again.',
    );
  }

  // Some endpoints may return empty body
  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

/**
 * Make an authenticated raw request (for binary downloads).
 *
 * @param path  API path relative to base
 * @param options  Additional fetch options
 * @returns Raw Response object
 */
export async function pandadocFetchRaw(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const key = getApiKey();
  if (!key) {
    throw new PandaDocError(
      'PandaDoc API key not configured',
      'AUTH_REQUIRED',
      'Use configure_pandadoc_api_key to set your API key first.',
    );
  }

  const url = `${PANDADOC_API_BASE}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `API-Key ${key}`,
        Accept: 'application/pdf',
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new PandaDocError(
        'Request to PandaDoc API timed out',
        'TIMEOUT',
        'The request took too long. Try again or check if the PandaDoc API is available.',
      );
    }
    throw error;
  }

  if (response.status === 401 || response.status === 403) {
    throw new PandaDocError(
      'Authentication failed',
      'AUTH_FAILED',
      'Your PandaDoc API key is invalid or revoked. Use configure_pandadoc_api_key to set a new key.',
    );
  }

  if (response.status === 409) {
    throw new PandaDocError(
      'Document is not ready for download. It may still be processing or in draft status.',
      'CONFLICT',
      'Check the document status with get_document_status. Documents must be sent or completed to download.',
    );
  }

  if (response.status === 404) {
    throw new PandaDocError(
      'Document not found.',
      'NOT_FOUND',
      'Verify the document ID is correct using list_documents.',
    );
  }

  if (!response.ok) {
    throw new PandaDocError(
      `Download failed (${response.status}): ${response.statusText}`,
      'DOWNLOAD_ERROR',
      'Check the document status and try again.',
    );
  }

  return response;
}
