/**
 * Remote (https://) source-image fetching for `nano_banana_edit`.
 *
 * Security posture (SSRF hardening):
 *  - https:// only — plain http:// is refused.
 *  - URLs carrying userinfo (`https://user:pass@host/...`) are refused.
 *  - Private / loopback / link-local / reserved hosts are refused, and
 *    redirects are followed MANUALLY with every hop re-validated against
 *    the same rules (a 302 to an internal address is refused).
 *  - The response must declare a supported image Content-Type
 *    (PNG / JPEG / WebP) and stay under MAX_REMOTE_IMAGE_BYTES; the cap is
 *    enforced both on the Content-Length header (early) and while streaming
 *    the body (a lying header cannot overflow it).
 */

import { NanoBananaError } from '../types.js';

/**
 * Vendor guidance: keep individual reference images under ~20MB.
 */
export const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;

export const REMOTE_IMAGE_TIMEOUT_MS = 30_000;

const MAX_REDIRECTS = 3;

const CONTENT_TYPE_TO_MIME: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
};

export interface RemoteImage {
  mimeType: string;
  base64: string;
  bytes: number;
}

/**
 * Detect whether a user-supplied source image is a remote URL
 * (https:// / http://). Remote URLs bypass the local-file sandbox —
 * they never touch the filesystem.
 */
export function isRemoteImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Check whether a hostname is private, localhost, or otherwise reserved.
 * Same pattern as the sibling connectors' download-URL guards.
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
 * Validate a remote source-image URL. Throws a NanoBananaError with code
 * URL_REJECTED on any failure. Every redirect hop is re-validated through
 * this function before being followed.
 */
export function validateRemoteImageUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new NanoBananaError(
      'Invalid source image URL',
      'URL_REJECTED',
      'Pass a valid https:// URL pointing directly at a PNG, JPEG, or WebP image.',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new NanoBananaError(
      `Refusing non-HTTPS source image URL scheme '${parsed.protocol.replace(/:$/, '')}'`,
      'URL_REJECTED',
      'Only https:// URLs are supported for remote source images. Download the image into the workspace and pass a local path instead.',
    );
  }

  if (parsed.username || parsed.password) {
    throw new NanoBananaError(
      'Refusing source image URL containing userinfo (user:pass@host)',
      'URL_REJECTED',
      'Strip credentials from the URL; only plain https:// image URLs are accepted.',
    );
  }

  if (isPrivateOrReservedHost(parsed.hostname)) {
    throw new NanoBananaError(
      `Refusing source image URL whose host '${parsed.hostname}' is a private/loopback/reserved address`,
      'URL_REJECTED',
      'Remote source images must be fetched from public hosts. Download the image into the workspace and pass a local path instead.',
    );
  }

  return parsed;
}

function fetchFailure(message: string, resolution: string): NanoBananaError {
  return new NanoBananaError(message, 'REMOTE_IMAGE_FETCH_FAILED', resolution);
}

/**
 * Fetch a remote source image and return it base64-encoded.
 * Throws NanoBananaError (URL_REJECTED / REMOTE_IMAGE_FETCH_FAILED /
 * REMOTE_IMAGE_NOT_IMAGE / REMOTE_IMAGE_TOO_LARGE) on any failure.
 */
export async function fetchRemoteImage(input: string): Promise<RemoteImage> {
  let url = validateRemoteImageUrl(input);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS),
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      throw fetchFailure(
        `Failed to fetch remote source image: ${errMsg}`,
        'Check the URL is reachable and points directly to a PNG/JPEG/WebP image, or download it into the workspace and pass a local path.',
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw fetchFailure(
          `Remote source image redirected (HTTP ${response.status}) without a Location header`,
          'Pass the final image URL directly.',
        );
      }
      // Re-validate every hop: a redirect must not downgrade to http:// or
      // bounce to a private/internal host.
      url = validateRemoteImageUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      throw fetchFailure(
        `Failed to fetch remote source image (HTTP ${response.status})`,
        'Check the URL points directly at an image and is publicly reachable.',
      );
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const mimeType = CONTENT_TYPE_TO_MIME[contentType];
    if (!mimeType) {
      throw new NanoBananaError(
        `Remote URL did not return a supported image (Content-Type: ${contentType || 'none'})`,
        'REMOTE_IMAGE_NOT_IMAGE',
        'The URL must serve a PNG, JPEG, or WebP image.',
      );
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_IMAGE_BYTES) {
      throw new NanoBananaError(
        `Remote source image is too large (${declaredLength} bytes; max ${MAX_REMOTE_IMAGE_BYTES})`,
        'REMOTE_IMAGE_TOO_LARGE',
        'Use an image under 20MB, or download it into the workspace and pass a local path.',
      );
    }

    if (!response.body) {
      throw fetchFailure(
        'Remote source image response had no body',
        'Check the URL points directly at an image and is publicly reachable.',
      );
    }

    // Stream with a hard cap — a missing or lying Content-Length cannot
    // push the read past MAX_REMOTE_IMAGE_BYTES.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REMOTE_IMAGE_BYTES) {
        // NB: not awaited — some mocked transports never settle cancel().
        reader.cancel().catch(() => undefined);
        throw new NanoBananaError(
          `Remote source image exceeded the ${MAX_REMOTE_IMAGE_BYTES}-byte limit while downloading`,
          'REMOTE_IMAGE_TOO_LARGE',
          'Use an image under 20MB, or download it into the workspace and pass a local path.',
        );
      }
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    console.error(`[NanoBanana] Fetched remote source image: ${buffer.length} bytes, type: ${mimeType}`);
    return { mimeType, base64: buffer.toString('base64'), bytes: buffer.length };
  }

  throw fetchFailure(
    `Remote source image redirected more than ${MAX_REDIRECTS} times`,
    'Pass the final image URL directly.',
  );
}
