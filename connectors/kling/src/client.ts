/**
 * Kling API HTTP client.
 *
 * Centralises JWT Bearer auth injection, error handling, rate-limit
 * messaging, and timeout handling for all Kling API calls.
 *
 * Security properties enforced here for every call:
 *  - Absolute URLs are accepted only on the exact Kling API origin, so the
 *    bearer JWT can never be sent to a caller-supplied host.
 *  - Every response body is validated fail-closed with Zod (envelope, then
 *    the per-endpoint `data` schema) before it reaches tool code. Malformed
 *    JSON or a shape mismatch surfaces as a generic INVALID_RESPONSE error —
 *    raw parser messages can embed fragments of the vendor payload and must
 *    never reach model-visible output.
 *  - Vendor-supplied error messages are credential-redacted and wrapped in an
 *    `<untrusted-content>` envelope (AGENTS.md invariant #6) before they can
 *    reach model-visible output.
 */

import { z } from 'zod';
import { isConfigured, getJwtToken, redactSecrets } from './auth.js';
import { wrapUntrusted } from './untrusted-content.js';
import {
  KlingError,
  KLING_API_BASE,
  getRequestTimeoutMs,
  klingEnvelopeSchema,
  klingVendorErrorSchema,
} from './types.js';

/** Exact origin the bearer JWT may be sent to. Derived from the fixed base. */
const KLING_API_ORIGIN = new URL(KLING_API_BASE).origin;

/** Envelope source label for vendor-authored error text. */
const VENDOR_ERROR_SOURCE = 'kling-api-error';

/**
 * Vendor error text is attacker-controllable: redact any echoed credentials,
 * then envelope it so the model treats it as data, not instructions.
 */
function sanitizeVendorMessage(message: string): string {
  // wrapUntrusted only returns undefined for undefined input.
  return wrapUntrusted(redactSecrets(message), VENDOR_ERROR_SOURCE)!;
}

/**
 * Get user-friendly resolution for common Kling error codes.
 */
function getErrorResolution(code: number, message?: string): string {
  const msg = message?.toLowerCase() || '';

  // Kling-specific error codes
  if (code >= 1000 && code <= 1004) {
    return 'Authentication failed. Check your Kling API credentials in Settings. Get keys from https://app.klingai.com/global/dev/api-key';
  }
  if (code === 1102) {
    return 'Insufficient credits. Purchase more at https://app.klingai.com/global/dev/billing';
  }
  if (code === 1201) {
    return 'Invalid request parameters. Check the prompt, model, and other settings.';
  }

  // Fallback to message-based matching
  if (msg.includes('auth') || msg.includes('token')) {
    return 'Check your Kling API credentials in Settings. Get keys from https://app.klingai.com/global/dev/api-key';
  }
  if (
    msg.includes('insufficient') ||
    msg.includes('balance') ||
    msg.includes('credit') ||
    msg.includes('not enough')
  ) {
    return 'Insufficient credits. Purchase more at https://app.klingai.com/global/dev/billing';
  }
  if (msg.includes('content') || msg.includes('policy') || msg.includes('moderation')) {
    return 'Content policy violation. Try a different prompt without sensitive content.';
  }
  return 'Please try again. If the issue persists, check the Kling AI status page.';
}

/**
 * Resolve the request URL. Relative paths are prefixed with the fixed Kling
 * API base. Absolute https:// URLs are permitted ONLY on the exact Kling API
 * origin — needed for the account costs endpoint, which Kling documents at
 * the domain root (/account/costs) rather than under /v1. Any other absolute
 * URL is refused so the bearer JWT can never leak to a third-party host.
 */
function resolveApiUrl(path: string): string {
  if (!path.startsWith('https://')) {
    return `${KLING_API_BASE}${path}`;
  }
  let origin: string;
  try {
    origin = new URL(path).origin;
  } catch {
    throw new KlingError(
      'Invalid API URL',
      'INVALID_URL',
      'Internal connector error: a malformed absolute URL was requested.',
    );
  }
  if (origin !== KLING_API_ORIGIN) {
    throw new KlingError(
      'Refused to send Kling credentials to a URL outside the Kling API origin',
      'URL_ORIGIN_REFUSED',
      'Internal connector error: only Kling API URLs may be requested with authentication.',
    );
  }
  return path;
}

function invalidResponseError(detail: string): KlingError {
  // Detail (issue counts, HTTP status) goes to stderr only; the model-visible
  // message stays generic and free of vendor-controlled content.
  console.error(`[kling] ${detail}`);
  return new KlingError(
    'Kling API returned an unexpected response shape',
    'INVALID_RESPONSE',
    'The Kling API response did not match the expected schema. If this persists, the API may have changed — check for a connector update.',
  );
}

/**
 * Make an authenticated request to the Kling API.
 *
 * @param path  API path relative to base, e.g. `/videos/text2video`
 * @param schema  Zod schema the response `data` payload must satisfy
 * @param options  Additional fetch options
 * @returns Parsed, schema-validated response data (unwrapped from Kling's
 *   { code, message, data } envelope)
 */
export async function klingFetch<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  options: RequestInit = {},
): Promise<z.infer<S>> {
  if (!isConfigured()) {
    throw new KlingError(
      'Kling API credentials not configured',
      'AUTH_REQUIRED',
      'Use configure_kling_api_keys to set your access key and secret key first.',
    );
  }

  const jwt = await getJwtToken();
  const url = resolveApiUrl(path);

  let response: Response;

  const timeoutMs = getRequestTimeoutMs();
  // Compose caller-supplied signal (if any) with our timeout so the built-in
  // ceiling always applies — even when a caller passes its own AbortSignal.
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
        Authorization: `Bearer ${jwt}`,
        ...options.headers,
      },
    });
  } catch (error) {
    // Attribute timeout to OUR signal only (not any caller-supplied TimeoutError):
    // timeoutSignal.aborted goes true iff its timer actually expired. If the caller
    // aborted first, their AbortError rethrows unchanged.
    if (timeoutSignal.aborted) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      throw new KlingError(
        `Request to Kling API timed out after ${timeoutSec}s`,
        'TIMEOUT',
        `The request took longer than ${timeoutSec}s. Set KLING_REQUEST_TIMEOUT_MS to increase the timeout, or try again.`,
      );
    }
    throw error;
  }

  // Handle rate limiting
  if (response.status === 429) {
    let vendor: z.infer<typeof klingVendorErrorSchema> | undefined;
    try {
      const parsed = klingVendorErrorSchema.safeParse(await response.json());
      if (parsed.success) vendor = parsed.data;
    } catch {
      /* non-JSON body — fall through to the generic rate-limit message */
    }
    if (vendor && vendor.message) {
      throw new KlingError(
        sanitizeVendorMessage(vendor.message),
        `KLING_${vendor.code}`,
        getErrorResolution(vendor.code, vendor.message),
      );
    }
    const retryAfter = response.headers.get('Retry-After');
    const waitTime = retryAfter ? `${retryAfter} seconds` : '30 seconds';
    throw new KlingError(
      `Rate limited by Kling API. Please wait ${waitTime} before retrying.`,
      'RATE_LIMITED',
      `Wait ${waitTime} and try again.`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new KlingError(
      'Authentication failed',
      'AUTH_FAILED',
      'Your Kling API credentials are invalid or expired. Use configure_kling_api_keys to set new credentials.',
    );
  }

  // Handle non-OK responses that may not be JSON. The vendor body is only
  // surfaced through a sanitized, enveloped message — never verbatim.
  if (!response.ok) {
    let vendor: z.infer<typeof klingVendorErrorSchema> | undefined;
    try {
      const parsed = klingVendorErrorSchema.safeParse(await response.json());
      if (parsed.success) vendor = parsed.data;
    } catch {
      /* not JSON */
    }
    if (vendor) {
      throw new KlingError(
        vendor.message
          ? sanitizeVendorMessage(vendor.message)
          : `Kling API error (HTTP ${response.status})`,
        `KLING_${vendor.code}`,
        getErrorResolution(vendor.code, vendor.message),
      );
    }
    throw new KlingError(
      `Kling API error (HTTP ${response.status})`,
      `HTTP_${response.status}`,
      response.status === 404
        ? 'The API endpoint was not found. The Kling API may have changed.'
        : 'Please try again. If the issue persists, check your API credentials.',
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch {
    throw invalidResponseError(`malformed JSON body (HTTP ${response.status}) for ${path}`);
  }

  const envelope = klingEnvelopeSchema.safeParse(rawBody);
  if (!envelope.success) {
    throw invalidResponseError(
      `response failed envelope validation for ${path} (${envelope.error.issues.length} issue(s))`,
    );
  }

  // Kling API returns code 0 for success
  if (envelope.data.code !== 0) {
    const vendorMessage = envelope.data.message;
    throw new KlingError(
      vendorMessage
        ? sanitizeVendorMessage(vendorMessage)
        : `Kling API error: ${envelope.data.code}`,
      `KLING_${envelope.data.code}`,
      getErrorResolution(envelope.data.code, vendorMessage),
    );
  }

  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) {
    throw invalidResponseError(
      `response data failed schema validation for ${path} (${parsed.error.issues.length} issue(s))`,
    );
  }

  return parsed.data;
}
