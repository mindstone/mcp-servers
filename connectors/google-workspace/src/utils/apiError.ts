import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { wrapUntrustedContent } from './untrusted-controls.js';
import { unwrapUntrusted } from './untrusted-content.js';
import {
  GOOGLE_RATE_LIMIT_NEXT_STEP,
  LONG_WINDOW_QUOTA,
  errorText,
  isGoogleRecoveryExhausted,
  isShortWindowRateLimit,
  preserveGoogleRetryDecision,
} from './google-retry.js';
import { AccountError } from '../modules/accounts/types.js';

/**
 * Links `target` to the original thrown value as a non-enumerable `cause`, so
 * status and reason stay reachable (cause-walking readers) without the original
 * error's text being copied by `JSON.stringify` or object spread. An existing
 * own `cause` is never overwritten.
 */
export function withCause<T extends object>(target: T, cause: unknown): T {
  if (cause !== undefined && !Object.prototype.hasOwnProperty.call(target, 'cause')) {
    Object.defineProperty(target, 'cause', { value: cause, enumerable: false, writable: true, configurable: true });
  }
  return target;
}

/** A service's `{ success: false, error }` result, keeping the caught error as `cause`. */
export function failedResult(error: unknown, text: string): { success: false; error: string } {
  return withCause({ success: false as const, error: text }, error);
}

/** A handler's McpError built from a failed result, keeping the result's `cause`. */
export function operationFailure(result: { readonly cause?: unknown }, message: string): McpError {
  return withCause(new McpError(ErrorCode.InternalError, message), result.cause);
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

/**
 * Extracts the HTTP status from a googleapis (GaxiosError-shaped) failure,
 * preferring `response.status` and falling back to a top-level `status` or a
 * numeric `code`. Returns undefined when no numeric status can be recovered
 * (e.g. a DNS `ENOTFOUND` where `code` is a non-numeric string).
 */
export function extractHttpStatus(error: unknown): number | undefined {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    const candidate = current as { response?: { status?: unknown }; status?: unknown; code?: unknown; cause?: unknown };
    if (isHttpStatus(candidate.response?.status)) return candidate.response.status;
    if (isHttpStatus(candidate.status)) return candidate.status;
    if (isHttpStatus(candidate.code)) return candidate.code;
    if (typeof candidate.code === 'string' && /^\d+$/.test(candidate.code)) {
      const status = Number(candidate.code);
      if (isHttpStatus(status)) return status;
    }
    seen.add(current);
    current = candidate.cause;
  }
  return undefined;
}

// Google controls these bytes; only a plain identifier may reach trusted text.
const GOOGLE_REASON = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function firstReason(errors: unknown): unknown {
  return Array.isArray(errors) ? asRecord(errors[0])?.reason : undefined;
}

/**
 * Google's reason code for a failure (e.g. `insufficientPermissions`), read
 * through the `cause` chain from the error body's `ErrorInfo` detail, its
 * `errors[0].reason`, the thrown error's own `errors[0].reason`, then the
 * body's `status`. Anything that is not a plain identifier is dropped.
 */
export function googleErrorReason(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    const node = current as { response?: { data?: unknown }; errors?: unknown; cause?: unknown };
    const body = asRecord(asRecord(node.response?.data)?.error);
    const errorInfo = Array.isArray(body?.details)
      ? body.details.map(asRecord).find(detail =>
        typeof detail?.['@type'] === 'string' && detail['@type'].endsWith('google.rpc.ErrorInfo'))
      : undefined;
    for (const candidate of [errorInfo?.reason, firstReason(body?.errors), firstReason(node.errors), body?.status]) {
      if (typeof candidate === 'string' && GOOGLE_REASON.test(candidate)) return candidate;
    }
    seen.add(current);
    current = node.cause;
  }
  return undefined;
}

/** True when the failure is a short-window rate limit (the host may retry it). */
export function isShortWindowFailure(error: unknown): boolean {
  return extractHttpStatus(error) === 429 || isGoogleRecoveryExhausted(error) || isShortWindowRateLimit(error);
}

/**
 * The short window ('minute' or 'second') a Google quota message names, using
 * the same tests Rebel's host applied to Google's raw text before this summary
 * existed (not daily; `quota exceeded`; `per minute` or `per second`), so every
 * message the host retried then still yields a summary it retries, and no other.
 */
function shortWindowUnit(text: string): 'minute' | 'second' | undefined {
  if (/\b(?:daily|per day|per_day|dailyLimitExceeded)\b/i.test(text)) return undefined;
  if (!/\bquota exceeded\b/i.test(text)) return undefined;
  const unit = /\bper (minute|second)\b/i.exec(text)?.[1]?.toLowerCase();
  return unit === 'minute' || unit === 'second' ? unit : undefined;
}

/** The kinds of Google failure the summary and the next step both describe. */
export type GoogleFailureKind = 'daily_limit' | 'short_window' | 'refused' | 'not_found' | 'temporary' | 'other';

/**
 * Classifies a Google failure once, for both the summary and the next step. The
 * daily check comes first so a daily-limit 429 is not told to wait a minute
 * (neither is retried by the host).
 */
export function classifyGoogleFailure(error: unknown): GoogleFailureKind {
  const status = extractHttpStatus(error);
  const reason = googleErrorReason(error);
  const text = errorText(error);
  if (LONG_WINDOW_QUOTA.test(text) || (reason !== undefined && LONG_WINDOW_QUOTA.test(reason))) return 'daily_limit';
  if (isShortWindowFailure(error) || (status === 403 && shortWindowUnit(text) !== undefined)) return 'short_window';
  if (status === 403) return 'refused';
  if (status === 404) return 'not_found';
  if (status !== undefined && status >= 500) return 'temporary';
  return 'other';
}

export const GENERIC_NEXT_STEP = 'Review the error, adjust the request if needed, and retry.';

/** A result's `next_step` for a failure kind, matching what its summary says to do. */
export function googleFailureNextStep(kind: GoogleFailureKind): string {
  switch (kind) {
    case 'daily_limit':
      return "Google's daily limit for this account was reached, so retrying today will not help. Try again tomorrow, or ask the Google Workspace administrator about the limit.";
    case 'short_window':
      return GOOGLE_RATE_LIMIT_NEXT_STEP;
    case 'refused':
      return 'Check that this Google account can open the item. If it cannot, ask the owner for access. Otherwise, sign in to Google again and allow the access it asks for, then try again.';
    case 'not_found':
      return 'Google could not find the item. Check the link or ID, and that this Google account can see the item, then try again.';
    case 'temporary':
      return 'Wait a moment, then try again.';
    case 'other':
      return GENERIC_NEXT_STEP;
  }
}

/**
 * A connector-written summary of a Google failure: what happened, the HTTP
 * status, Google's reason code and what to do next. Google's text only picks
 * the wording; none of it is copied in. Rebel's host reads this text: a
 * per-minute (or per-second) quota 403 says `quota exceeded per minute` and
 * `(status 403)` (retried), and only the daily branch says `daily` (stops).
 */
export function summariseGoogleError(error: unknown, subject = 'Google Workspace'): string {
  const status = extractHttpStatus(error);
  const reason = googleErrorReason(error);
  let what: string;
  let next: string;
  switch (classifyGoogleFailure(error)) {
    case 'daily_limit':
      what = "Google's daily limit was reached";
      next = 'Try again tomorrow, or ask your Google Workspace administrator about the limit.';
      break;
    case 'short_window': {
      const unit = shortWindowUnit(errorText(error));
      what = unit !== undefined
        ? `Google received too many requests in a short time (quota exceeded per ${unit})`
        : 'Google received too many requests in a short time';
      next = 'Wait a minute, then try again.';
      break;
    }
    case 'refused':
      what = 'Google refused access';
      next = 'Check that this Google account can open the item, or sign in to Google again and allow the access it asks for.';
      break;
    case 'not_found':
      what = 'the item was not found';
      next = 'Check the link or ID, and that this account can see the item.';
      break;
    case 'temporary':
      what = 'Google had a temporary problem';
      next = 'Try again shortly.';
      break;
    case 'other':
      what = status !== undefined ? 'Google returned an error' : 'the request failed';
      next = 'Check the details given (such as IDs, dates and addresses) and try again.';
      break;
  }
  const statusPart = status !== undefined ? ` (status ${status})` : '';
  const reasonPart = reason !== undefined ? `. Reason: ${reason}` : '';
  return `${subject}: ${what}${statusPart}${reasonPart}. ${next}`;
}

const WELL_FORMED_ENVELOPE = /<untrusted-content source="[^"]*">[\s\S]*?<\/untrusted-content>/g;

/**
 * Error text that is not the connector's own, in exactly one untrusted-content
 * envelope: envelopes already inside it are flattened first, so a message that
 * quoted an enveloped Google string is not nested.
 */
export function envelopeErrorDetail(text: string, source = 'google-workspace:api-error'): string {
  return wrapUntrustedContent(text.replace(WELL_FORMED_ENVELOPE, match => unwrapUntrusted(match)), source);
}

/**
 * Turns an unknown thrown value into a diagnosable one-line string: the error
 * message plus the HTTP status when one is recoverable. This is what should be
 * stored in a domain error's `details` field so the real Google cause survives
 * to the user instead of collapsing to "Unknown error".
 */
export function describeApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const status = extractHttpStatus(error);
  return status !== undefined ? `${message} (status ${status})` : message;
}

/**
 * describeApiError with the error message wrapped as untrusted content (the
 * HTTP status stays outside). Google's error text can quote request or
 * document content, so results that reach the model carry it enveloped.
 */
export function describeApiErrorUntrusted(error: unknown, source: string): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const status = extractHttpStatus(error);
  const wrapped = wrapUntrustedContent(message, source);
  return status !== undefined ? `${wrapped} (status ${status})` : wrapped;
}

/**
 * Structural check for this connector's domain error classes (GmailError,
 * CalendarError, ContactsError, GoogleServiceError). They all share a
 * `{ message, code, details }` shape with string `code` and string `details`,
 * but have no common base class, so we key on that shape rather than any single
 * `instanceof`. Requiring a string `code` (which every domain error sets when
 * it carries details) guards against a raw transport error (e.g. a GaxiosError
 * with a numeric/string HTTP `code` and some string `details`) being mistaken
 * for a domain error.
 */
export function hasErrorDetails(error: unknown): error is { message: string; code: string; details: string } {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { message?: unknown; code?: unknown; details?: unknown };
  return (
    typeof candidate.message === 'string' &&
    typeof candidate.code === 'string' &&
    typeof candidate.details === 'string'
  );
}

/**
 * Auth-handoff error codes: a domain error (AccountError / CalendarError / …)
 * carrying one of these codes must NOT be wrapped into a generic McpError —
 * `server.ts` `formatErrorResponse` keys the structured `auth_required`
 * reconnect handoff on the raw domain error's string `code`. TEMPORARY_AUTH_ERROR
 * (a transient refresh blip) is included so its "try again" resolution survives
 * to the user; formatErrorResponse deliberately does NOT map it to the
 * reconnect CTA. Kept as a
 * structural check (no class import) so it works uniformly across every domain
 * error type without coupling this util to the accounts/calendar/gmail modules.
 */
const AUTH_HANDOFF_CODES = new Set([
  'AUTH_REQUIRED',
  'HOST_ORCHESTRATED_AUTH_REQUIRED',
  'TEMPORARY_AUTH_ERROR',
  // Like TEMPORARY_AUTH_ERROR: passed through so its resolution survives; formatErrorResponse
  // does not map it to the reconnect handoff.
  'CREDENTIAL_FILE_REFUSED',
]);

/**
 * True when `error` is a thrown value that signals the account needs
 * (re)authentication — i.e. it exposes a string `code` in {@link AUTH_HANDOFF_CODES}.
 */
export function isAuthHandoffError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && AUTH_HANDOFF_CODES.has(code);
}

/**
 * True when the server's `formatErrorResponse` owns this error's tool result: an
 * auth hand-off code (the `auth_required` reconnect, or a pass-through such as
 * `CREDENTIAL_FILE_REFUSED`) or any `AccountError`, whose `resolution` is connector
 * text. A handler's own result builder rethrows these instead of summarising them,
 * so the resolution and the hand-off are written in one place.
 */
export function isServerFormattedError(error: unknown): boolean {
  return isAuthHandoffError(error) || error instanceof AccountError;
}

/** Keep structured recovery decisions out of lossy string-only error results. */
export function isPassthroughGoogleError(error: unknown): boolean {
  return isAuthHandoffError(error) || isGoogleRecoveryExhausted(error) || extractHttpStatus(error) === 429 || isShortWindowRateLimit(error);
}

/**
 * Normalizes any thrown value into an error suitable for a tool handler's outer
 * catch. An McpError (e.g. an InvalidParams validation failure raised earlier
 * in the handler) is passed through unchanged so its code and message survive.
 * An **auth-handoff domain error** (code `AUTH_REQUIRED` /
 * `HOST_ORCHESTRATED_AUTH_REQUIRED`) is ALSO passed through unchanged: wrapping
 * it into `McpError(InternalError)` would erase the domain `code` that
 * `formatErrorResponse` reads to emit the `auth_required` reconnect handoff,
 * silently degrading an expired-token failure to a generic "Failed to …"
 * message. A short-window rate-limit transport error is also passed through so
 * the server can preserve its status and emit rate-limit guidance. Any other
 * domain error surfaces its `details`; anything else is described with its HTTP
 * status. Prevents the "Failed to X" opaque-error class where the real cause
 * was silently dropped.
 */
export function toMcpError(error: unknown, fallbackContext: string): Error {
  if (error instanceof McpError) return error;
  if (isAuthHandoffError(error) && error instanceof Error) return error;
  if ((extractHttpStatus(error) === 429 || isShortWindowRateLimit(error)) && error instanceof Error) return error;
  const detail = hasErrorDetails(error) && error.details
    ? `${error.message}: ${error.details}`
    : isGoogleRecoveryExhausted(error)
      ? describeApiErrorUntrusted(error, 'google-workspace:api-error')
    : describeApiError(error);
  return preserveGoogleRetryDecision(
    withCause(new McpError(ErrorCode.InternalError, `${fallbackContext}: ${detail}`), error),
    error,
  );
}
