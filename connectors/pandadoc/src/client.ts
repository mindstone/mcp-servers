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
import { sanitizeVendorErrorText } from './utils.js';

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
      errorBody
        ? `Conflict (409): ${sanitizeVendorErrorText(errorBody, 'pandadoc:client:error_409')}`
        : 'Conflict (409): Document is not ready for this operation.',
      'CONFLICT',
      'Check the document status with get_document_status. The document may not be in the required state.',
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new PandaDocError(
      `PandaDoc API error (${response.status}): ${
        errorText
          ? sanitizeVendorErrorText(errorText, 'pandadoc:client:error_body')
          : 'no error details provided'
      }`,
      'API_ERROR',
      'Check the request parameters and try again.',
    );
  }

  // Some endpoints may return empty body
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A JSON.parse failure message is runtime-generated and can echo body
    // fragments — never surface it (or the body) to the model.
    throw new PandaDocError(
      `PandaDoc API returned a malformed (non-JSON) response (status ${response.status}).`,
      'INVALID_RESPONSE',
      'Try the request again. If it persists, the PandaDoc API may be degraded.',
    );
  }
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
    // statusText is server-controlled text — surface the numeric status only.
    throw new PandaDocError(
      `Download failed (HTTP ${response.status}).`,
      'DOWNLOAD_ERROR',
      'Check the document status and try again.',
    );
  }

  return response;
}

const DOWNLOAD_TOO_LARGE_RESOLUTION =
  'Download a smaller document (or fewer sections), or download it from the PandaDoc website instead.';

function downloadTooLarge(maxBytes: number): PandaDocError {
  return new PandaDocError(
    `Document is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB download limit.`,
    'DOWNLOAD_TOO_LARGE',
    DOWNLOAD_TOO_LARGE_RESOLUTION,
  );
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Read a response body into memory, refusing one larger than `maxBytes`.
 *
 * `Content-Length` only allows an early refusal; the bytes are always counted,
 * so a missing or understated header cannot get past the cap. The request's
 * own timeout signal stays armed across the body read.
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && /^\d+$/.test(declared.trim())) {
    const declaredBytes = Number(declared.trim());
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      // Cleanup is not awaited: a refusal must not wait on (or be replaced
      // by) discarding the body.
      void response.body?.cancel().catch(() => {
        console.error('[pandadoc] oversized download body could not be discarded');
      });
      throw downloadTooLarge(maxBytes);
    }
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        if (isTimeoutLike(error)) {
          throw new PandaDocError(
            'Request to PandaDoc API timed out',
            'TIMEOUT',
            'The request took too long. Try again or check if the PandaDoc API is available.',
          );
        }
        throw error;
      }
      if (next.done) break;
      const chunk = next.value;
      if (total + chunk.byteLength > maxBytes) {
        void reader.cancel().catch(() => {
          console.error('[pandadoc] oversized download stream could not be cancelled');
        });
        throw downloadTooLarge(maxBytes);
      }
      total += chunk.byteLength;
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
