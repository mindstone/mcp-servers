/**
 * OpusClip API HTTP client.
 *
 * Centralises:
 *  - Bearer auth header injection (key read via `getApiKey()` at request time)
 *  - Two timeout regimes: `OPUS_API_TIMEOUT_MS` (general API) and
 *    `OPUS_UPLOAD_TIMEOUT_MS` (GCS resumable upload chunks)
 *  - Composition with caller `AbortSignal` via `AbortSignal.any()`
 *  - Error normalisation into typed `OpusError` (with `code` and `resolution`)
 *  - `Retry-After` parsing (seconds AND HTTP-date — see D11) for 429 responses
 *  - Observable `UPSTREAM_STATUS_UNKNOWN` mode for async-job pollers
 *
 * Base URL: https://api.opus.pro
 */

import { getApiKey } from './auth.js';
import {
  OpusError,
  getApiTimeoutMs,
  getUploadTimeoutMs,
  parseRetryAfter,
  KNOWN_JOB_STATUSES,
  type PollableJobResponse,
} from './types.js';
import { wrapUntrusted } from './untrusted-content.js';
import { UPLOAD_ALLOWED_HOST_SUFFIXES, validateOutboundUrlSync } from './url-safety.js';

export const OPUS_API_BASE = 'https://api.opus.pro';

/**
 * Strip query string and fragment from a URL before logging. Signed /
 * resumable-upload URLs carry bearer-like credentials in their query
 * parameters; the origin + pathname is sufficient for request tracing.
 */
function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[unparseable URL]';
  }
}

export interface OpusFetchOptions extends Omit<RequestInit, 'signal'> {
  /** Optional caller AbortSignal — composed via AbortSignal.any() with our timeout. */
  signal?: AbortSignal;
  /** Use the longer upload timeout for GCS resumable PUT/POST. Defaults to false. */
  uploadTimeout?: boolean;
  /** Override the default JSON parse behaviour — return the raw Response. */
  rawResponse?: boolean;
}

/**
 * Internal helper — fetches a URL with composed timeout signal and consistent
 * error normalisation. Returns the parsed JSON (default) or the raw
 * `Response` when `rawResponse: true`.
 */
async function opusFetchRaw<T>(
  url: string,
  options: OpusFetchOptions = {},
  injectAuth: boolean = true,
): Promise<T> {
  // Never log the full URL: GCS resumable/signed URLs carry bearer-like
  // query credentials (upload_id, X-Goog-Signature, …). Method +
  // origin + pathname is enough to trace a request.
  console.error(`[Opus API] ${options.method || 'GET'} ${redactUrlForLog(url)}`);

  const timeoutMs = options.uploadTimeout ? getUploadTimeoutMs() : getApiTimeoutMs();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callerSignal = options.signal;
  const fetchSignal =
    callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]);

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };

  if (injectAuth) {
    headers.Authorization = `Bearer ${getApiKey()}`;
  }

  // Default Content-Type only when there's a body and the caller didn't set one.
  if (
    options.body !== undefined &&
    options.body !== null &&
    !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type') &&
    typeof options.body === 'string'
  ) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      // Never auto-follow redirects: the connector must see 3xx responses
      // itself (GCS resumable uploads use 308 Resume Incomplete as a
      // control signal, and silently following a redirect anywhere else
      // would bypass the SSRF validation of the new destination).
      redirect: 'manual',
      ...options,
      signal: fetchSignal,
      headers,
    });
  } catch (error) {
    if (timeoutSignal.aborted) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      throw new OpusError(
        `Request to Opus API timed out after ${timeoutSec}s`,
        options.uploadTimeout ? 'UPLOAD_TIMEOUT' : 'TIMEOUT',
        options.uploadTimeout
          ? `The upload chunk took longer than ${timeoutSec}s. Set OPUS_UPLOAD_TIMEOUT_MS to increase the timeout, or try again.`
          : `The request took longer than ${timeoutSec}s. Set OPUS_API_TIMEOUT_MS to increase the timeout, or try again.`,
      );
    }
    // Re-throw caller-aborted or generic network errors as-is.
    throw error;
  }

  // 429 — rate limit. Parse Retry-After (seconds OR HTTP-date) per RFC 9110.
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const seconds = parseRetryAfter(retryAfter);
    const waitText = seconds !== null ? `${seconds} seconds` : 'a moment';
    throw new OpusError(
      `Rate limited. Please wait ${waitText} before retrying.`,
      'RATE_LIMITED',
      seconds !== null
        ? `Wait ${seconds} seconds and try again.`
        : 'Wait a few seconds and try again.',
    );
  }

  if (response.status === 401) {
    throw new OpusError(
      'Authentication failed',
      'AUTH_FAILED',
      'API key is invalid or revoked. Get a new key at https://app.opus.pro/settings/integration-tokens then call configure_opus_api_key.',
    );
  }

  if (response.status === 403) {
    throw new OpusError(
      'Access forbidden',
      'AUTH_FAILED',
      'Your API key does not have permission for this operation. Check that your Opus plan includes API access.',
    );
  }

  if (response.status === 404) {
    throw new OpusError(
      'Resource not found',
      'NOT_FOUND',
      'The requested resource does not exist. Check the ID and try again.',
    );
  }

  if (response.status === 422) {
    // The vendor body is attacker-controlled external text: envelope it
    // (invariant #6) before embedding it in an error message that becomes
    // model-visible via withErrorHandling. Bounded to keep errors readable.
    const text = await response.text().catch(() => '');
    const wrappedBody = wrapUntrusted(text.slice(0, 1000), 'opus:api:validation_error_body');
    throw new OpusError(
      `Validation error: ${wrappedBody ?? 'check request parameters'}`,
      'VALIDATION_ERROR',
      'The request body or parameters were rejected by the Opus API. Inspect the message and adjust the arguments.',
    );
  }

  // rawResponse callers handle non-2xx statuses themselves (GCS resumable
  // uploads treat 308 Resume Incomplete as a control signal carrying the
  // committed offset, and wrap their own error bodies), so hand them the
  // raw response rather than collapsing every non-2xx into API_ERROR.
  // Auth/rate-limit/not-found/validation statuses above still throw first.
  if (options.rawResponse) {
    return response as unknown as T;
  }

  if (!response.ok) {
    // Consume the body so the connection is released, but never log it:
    // vendor error bodies are not proven secret-free.
    await response.text().catch(() => '');
    console.error(`Opus API error (HTTP ${response.status})`);
    const message =
      response.status >= 500
        ? 'Opus server error - try again later'
        : `Request failed (${response.status})`;
    throw new OpusError(
      `Opus API error (${response.status}): ${message}`,
      'API_ERROR',
      'Check the request parameters and try again. If the error persists, report to Opus support.',
    );
  }

  // 204 No Content / empty body — return an empty object cast as T.
  if (response.status === 204) {
    return {} as T;
  }

  const text = await response.text();
  if (text.trim().length === 0) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new OpusError(
      `Unable to parse Opus API response as JSON: ${error instanceof Error ? error.message : String(error)}`,
      'API_ERROR',
      'The response body was not valid JSON. Report this to Opus support with the request details.',
    );
  }
}

/**
 * Authenticated request to the OpusClip API.
 */
export async function opusFetch<T>(
  endpoint: string,
  options: OpusFetchOptions = {},
): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${OPUS_API_BASE}${endpoint}`;
  return opusFetchRaw<T>(url, options, true);
}

/**
 * Unauthenticated request — used for the GCS resumable upload PUTs (the
 * upload URL is signed; adding Bearer would be wrong and could leak the key
 * if a future Opus change ever pointed `upload_url` at a non-GCS host).
 *
 * The URL is validated against the GCS host allow-list (HTTPS, no userinfo,
 * no non-public IP literals) before any request is issued: the initiation
 * and session URLs are upstream-supplied, so a poisoned Opus response must
 * not be able to point the connector's fetch at an arbitrary host (SSRF).
 * Combined with (a) the URLs being consumed only within `opus_upload_video`
 * and never persisted, and (b) the intentional omission of the Bearer
 * header, a non-GCS destination is both refused and useless.
 */
export async function opusFetchUnauthenticated<T>(
  url: string,
  options: OpusFetchOptions = {},
): Promise<T> {
  const urlError = validateOutboundUrlSync(url, UPLOAD_ALLOWED_HOST_SUFFIXES);
  if (urlError) {
    throw new OpusError(
      `Upload URL rejected: ${urlError}`,
      'URL_REJECTED',
      'The Opus API returned an unexpected upload URL. Re-run opus_upload_video to get a fresh upload link.',
    );
  }
  return opusFetchRaw<T>(url, options, false);
}

/**
 * Classify a job-status string per the documented enum. Unknown values are
 * surfaced as `UPSTREAM_STATUS_UNKNOWN` so they remain observable rather
 * than silently mapping to `pending` — see D12 in the planning doc.
 *
 * Opus uses different status vocabularies depending on the endpoint:
 *  - Censor jobs:       `CONCLUDED | FAILED | PROCESSING | QUEUED | UNKNOWN`
 *  - Social copy jobs:  `RUNNING | COMPLETED | FAILED`
 *
 * UNKNOWN (sent by the API itself for censor jobs) is treated as `unknown`
 * here so callers see it surfaced as `UPSTREAM_STATUS_UNKNOWN`, not silently
 * collapsed to pending.
 */
export function classifyJobStatus(status: string | undefined): {
  category: 'pending' | 'completed' | 'failed' | 'unknown';
  raw: string;
} {
  const raw = (status ?? '').trim();
  const upper = raw.toUpperCase();

  if (!upper) return { category: 'unknown', raw };

  // UNKNOWN must be treated as "unknown" even though Opus emits it.
  if (upper === 'UNKNOWN') return { category: 'unknown', raw };

  if (
    upper === 'PENDING' ||
    upper === 'QUEUED' ||
    upper === 'RUNNING' ||
    upper === 'IN_PROGRESS' ||
    upper === 'PROCESSING'
  ) {
    return { category: 'pending', raw };
  }
  if (upper === 'COMPLETED' || upper === 'CONCLUDED' || upper === 'SUCCEEDED') {
    return { category: 'completed', raw };
  }
  if (upper === 'FAILED' || upper === 'ERROR' || upper === 'CANCELED' || upper === 'CANCELLED') {
    return { category: 'failed', raw };
  }
  return { category: 'unknown', raw };
}

/**
 * Compute the next poll delay (seconds) for an async job. Uses the supplied
 * `Retry-After` if parseable; otherwise applies a bounded exponential
 * backoff starting at 5s and capping at 30s.
 */
export function computeNextPollAfterSeconds(
  retryAfterHeader: string | null,
  attempt: number,
): number {
  const parsed = parseRetryAfter(retryAfterHeader);
  if (parsed !== null) return Math.max(1, parsed);
  const base = 5;
  const max = 30;
  const value = Math.min(max, Math.round(base * Math.pow(1.5, Math.max(0, attempt - 1))));
  return value;
}

/**
 * Poll a single status endpoint once. Returns the parsed response, the
 * categorised status, and the recommended `next_poll_after_seconds` value
 * to surface to the caller.
 */
export async function pollOpusJob<T extends PollableJobResponse>(
  endpoint: string,
  attempt: number,
): Promise<{
  body: T;
  classification: { category: 'pending' | 'completed' | 'failed' | 'unknown'; raw: string };
  next_poll_after_seconds: number;
}> {
  // We need access to the raw response to read Retry-After.
  const response = (await opusFetch<Response>(endpoint, { rawResponse: true })) as Response;

  const retryAfterHeader = response.headers.get('Retry-After');
  let body: T;
  if (response.status === 204) {
    body = {} as T;
  } else {
    const text = await response.text();
    body = (text.trim().length === 0 ? {} : JSON.parse(text)) as T;
  }
  const classification = classifyJobStatus(body.status);
  const next_poll_after_seconds = computeNextPollAfterSeconds(retryAfterHeader, attempt);

  // The raw Retry-After header is attacker-controlled external text and is
  // deliberately NOT returned — callers surface the parsed numeric delay.
  return { body, classification, next_poll_after_seconds };
}

/**
 * Re-export the documented status enum for tests / consumers.
 */
export { KNOWN_JOB_STATUSES };
