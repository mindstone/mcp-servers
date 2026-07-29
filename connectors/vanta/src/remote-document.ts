import { VantaApiError, validateDocumentUrlWithDns } from './api.js';

// Vanta's upload endpoints take the file as multipart/form-data, so the connector
// fetches the caller-supplied URL itself and forwards the bytes. That makes this
// module a server-side fetcher, and every limit below is a security boundary
// rather than a tuning knob.
//
// Vanta publishes no maximum upload size for POST /v1/documents/{documentId}/uploads
// or POST /v1/vendors/{vendorId}/documents (checked 2026-07-29), so the cap is ours:
// 25 MB comfortably covers the accepted evidence formats (.pdf, .docx, .jpg, .png,
// .xlsx) while bounding the bytes this process buffers to build the multipart body.
const DEFAULT_MAX_REMOTE_DOCUMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_REMOTE_DOCUMENT_TIMEOUT_MS = 30_000;
// Presigned-storage and CDN document links routinely redirect once or twice, so
// refusing every redirect would refuse most real evidence URLs. Redirects are
// followed manually instead: each hop is re-validated through the same SSRF guard
// as the original URL, and this budget stops a redirect loop from becoming an
// unbounded fetch chain.
const MAX_REMOTE_DOCUMENT_REDIRECTS = 3;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';
const FALLBACK_FILE_NAME = 'document';
const MAX_FILE_NAME_LENGTH = 128;
// RFC 6838 restricted-name characters, lowercased. Anything else is treated as an
// untrustworthy Content-Type and replaced with the fallback.
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export interface RemoteDocument {
  // Explicitly ArrayBuffer-backed (not ArrayBufferLike) so the bytes can be handed
  // straight to Blob when the multipart body is assembled.
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  fileName: string;
}

let maxBytesOverride: number | undefined;
let timeoutMsOverride: number | undefined;

/**
 * Test seam: shrinks the size cap / timeout so the guards can be exercised without
 * streaming 25 MB or waiting 30 seconds. Pass null to restore production limits.
 */
export function setRemoteDocumentLimitsForTesting(
  limits: { maxBytes?: number; timeoutMs?: number } | null,
): void {
  maxBytesOverride = limits?.maxBytes;
  timeoutMsOverride = limits?.timeoutMs;
}

const maxBytes = (): number => maxBytesOverride ?? DEFAULT_MAX_REMOTE_DOCUMENT_BYTES;
const timeoutMs = (): number => timeoutMsOverride ?? DEFAULT_REMOTE_DOCUMENT_TIMEOUT_MS;

const tooLargeError = (limit: number): VantaApiError =>
  new VantaApiError(
    'SOURCE_TOO_LARGE',
    `The document at the supplied URL exceeds the ${limit} bytes this connector will upload.`,
    'The source file is larger than the connector uploads.',
    'Upload a smaller file, or split the evidence into multiple documents.',
  );

const unreachableError = (message: string, nextStep: string): VantaApiError =>
  new VantaApiError('SOURCE_UNREACHABLE', message, 'The document URL could not be read.', nextStep);

// Release an unread response body without awaiting: cancelling a stream can hang
// when the peer never completes the teardown, and every caller is already on its way
// to throwing, so there is nothing to wait for.
const discardBody = (body: ReadableStream<Uint8Array> | null): void => {
  void body?.cancel().catch(() => {});
};

const sanitizeFileName = (raw: string): string | null => {
  const withoutPath = raw.replace(/\\/g, '/');
  const collapsed = withoutPath.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, MAX_FILE_NAME_LENGTH);
  // A name made only of dots/underscores tells Vanta nothing and can confuse
  // downstream storage; fall back instead.
  return /[A-Za-z0-9]/.test(collapsed) ? collapsed : null;
};

const fileNameFromContentDisposition = (header: string | null): string | null => {
  if (!header) return null;
  const encoded = header.match(/filename\*=\s*[^']*'[^']*'([^;]+)/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // Malformed percent-encoding — fall through to the plain filename form.
    }
  }
  const plain = header.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
  if (plain) {
    return (plain[2] ?? plain[1]).trim();
  }
  return null;
};

const fileNameFromUrl = (url: URL): string | null => {
  const lastSegment = url.pathname.split('/').filter(Boolean).pop();
  if (!lastSegment) return null;
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
};

function resolveFileName(
  override: string | undefined,
  contentDisposition: string | null,
  finalUrl: URL,
): string {
  const candidates = [override, fileNameFromContentDisposition(contentDisposition), fileNameFromUrl(finalUrl)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const sanitized = sanitizeFileName(candidate);
    if (sanitized) return sanitized;
  }
  return FALLBACK_FILE_NAME;
}

function resolveContentType(header: string | null): string {
  const declared = header?.split(';')[0]?.trim().toLowerCase();
  if (!declared || !MIME_TYPE_PATTERN.test(declared)) {
    return FALLBACK_CONTENT_TYPE;
  }
  return declared;
}

const validateHop = async (rawUrl: string, fieldName: string, isRedirect: boolean): Promise<URL> => {
  try {
    return await validateDocumentUrlWithDns(rawUrl, fieldName);
  } catch (error) {
    if (isRedirect && error instanceof VantaApiError) {
      throw new VantaApiError(
        'CONFIG_INVALID',
        `The document URL followed a redirect that was refused: ${error.message}`,
        'A redirect from the document URL pointed somewhere this connector will not fetch.',
        'Pass a direct https:// URL that does not redirect through internal infrastructure.',
      );
    }
    throw error;
  }
};

const readCappedBody = async (response: Response): Promise<Uint8Array<ArrayBuffer>> => {
  const limit = maxBytes();
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    discardBody(response.body);
    throw tooLargeError(limit);
  }

  const body = response.body;
  if (!body) {
    throw unreachableError(
      'The document URL returned an empty response body.',
      'Verify the URL serves the file directly (not a login or preview page) and retry.',
    );
  }

  // Content-Length is advisory — a source can omit it or lie. The cap is enforced
  // against the bytes actually received, and the stream is cancelled the moment it
  // is exceeded so an oversized source cannot be drained into memory.
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > limit) {
      void reader.cancel().catch(() => {});
      throw tooLargeError(limit);
    }
    chunks.push(value);
  }

  if (received === 0) {
    throw unreachableError(
      'The document URL returned an empty response body.',
      'Verify the URL serves the file directly (not a login or preview page) and retry.',
    );
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/**
 * Fetches a caller-supplied document URL server-side so its bytes can be forwarded
 * to Vanta's multipart upload endpoints. HTTPS-only, SSRF-guarded on every hop,
 * size-capped during streaming, and time-bounded; every refusal is a distinct
 * structured VantaApiError rather than a silent fallback.
 */
export async function fetchRemoteDocument(
  rawUrl: string,
  options: { fieldName?: string; fileName?: string } = {},
): Promise<RemoteDocument> {
  const fieldName = options.fieldName ?? 'document_url';
  let current = await validateHop(rawUrl, fieldName, false);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs());

  try {
    for (let hop = 0; hop <= MAX_REMOTE_DOCUMENT_REDIRECTS; hop++) {
      let response: Response;
      try {
        response = await fetch(current, {
          method: 'GET',
          headers: { Accept: '*/*' },
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new VantaApiError(
            'SOURCE_TIMEOUT',
            `Fetching the document URL timed out after ${timeoutMs()}ms.`,
            'The document URL did not respond in time.',
            'Verify the URL is reachable and serves the file quickly, then retry.',
          );
        }
        throw unreachableError(
          `Fetching the document URL failed: ${error instanceof Error ? error.message : String(error)}`,
          'Verify the URL is publicly reachable over https:// and retry.',
        );
      }

      if (REDIRECT_STATUS_CODES.has(response.status)) {
        discardBody(response.body);
        const location = response.headers.get('location');
        if (!location) {
          throw unreachableError(
            `The document URL returned HTTP ${response.status} without a redirect target.`,
            'Pass a direct https:// URL to the file.',
          );
        }
        if (hop === MAX_REMOTE_DOCUMENT_REDIRECTS) {
          throw new VantaApiError(
            'SOURCE_REDIRECT_LIMIT',
            `The document URL redirected more than ${MAX_REMOTE_DOCUMENT_REDIRECTS} times.`,
            'The document URL redirects too many times.',
            'Pass the final https:// URL of the file instead of a redirecting link.',
          );
        }
        current = await validateHop(new URL(location, current).toString(), fieldName, true);
        continue;
      }

      if (!response.ok) {
        discardBody(response.body);
        throw unreachableError(
          `The document URL returned HTTP ${response.status}.`,
          'Verify the URL is publicly readable without authentication, then retry.',
        );
      }

      const bytes = await readCappedBody(response);
      return {
        bytes,
        contentType: resolveContentType(response.headers.get('content-type')),
        fileName: resolveFileName(options.fileName, response.headers.get('content-disposition'), current),
      };
    }

    // Unreachable: the loop either returns, redirects (bounded), or throws.
    throw new VantaApiError(
      'SOURCE_REDIRECT_LIMIT',
      `The document URL redirected more than ${MAX_REMOTE_DOCUMENT_REDIRECTS} times.`,
      'The document URL redirects too many times.',
      'Pass the final https:// URL of the file instead of a redirecting link.',
    );
  } catch (error) {
    if (error instanceof VantaApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new VantaApiError(
        'SOURCE_TIMEOUT',
        `Fetching the document URL timed out after ${timeoutMs()}ms.`,
        'The document URL did not respond in time.',
        'Verify the URL is reachable and serves the file quickly, then retry.',
      );
    }
    throw unreachableError(
      `Fetching the document URL failed: ${error instanceof Error ? error.message : String(error)}`,
      'Verify the URL is publicly reachable over https:// and retry.',
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Builds the multipart body Vanta's upload endpoints expect. */
export function buildUploadForm(
  document: RemoteDocument,
  fields: Record<string, string | undefined>,
): FormData {
  const form = new FormData();
  form.append('file', new Blob([document.bytes], { type: document.contentType }), document.fileName);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      form.append(key, value);
    }
  }
  return form;
}
