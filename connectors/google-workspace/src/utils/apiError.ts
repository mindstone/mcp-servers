import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * Extracts the HTTP status from a googleapis (GaxiosError-shaped) failure,
 * preferring `response.status` and falling back to a top-level `status` or a
 * numeric `code`. Returns undefined when no numeric status can be recovered
 * (e.g. a DNS `ENOTFOUND` where `code` is a non-numeric string).
 */
export function extractHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { response?: { status?: unknown }; status?: unknown; code?: unknown };
  if (typeof candidate.response?.status === 'number') return candidate.response.status;
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.code === 'number') return candidate.code;
  if (typeof candidate.code === 'string' && /^\d+$/.test(candidate.code)) return Number(candidate.code);
  return undefined;
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
const AUTH_HANDOFF_CODES = new Set(['AUTH_REQUIRED', 'HOST_ORCHESTRATED_AUTH_REQUIRED', 'TEMPORARY_AUTH_ERROR']);

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
 * Normalizes any thrown value into an error suitable for a tool handler's outer
 * catch. An McpError (e.g. an InvalidParams validation failure raised earlier
 * in the handler) is passed through unchanged so its code and message survive.
 * An **auth-handoff domain error** (code `AUTH_REQUIRED` /
 * `HOST_ORCHESTRATED_AUTH_REQUIRED`) is ALSO passed through unchanged: wrapping
 * it into `McpError(InternalError)` would erase the domain `code` that
 * `formatErrorResponse` reads to emit the `auth_required` reconnect handoff,
 * silently degrading an expired-token failure to a generic "Failed to …"
 * message. Any other domain error surfaces its `details`; anything else is
 * described with its HTTP status. Prevents the "Failed to X" opaque-error class
 * where the real cause was silently dropped.
 */
export function toMcpError(error: unknown, fallbackContext: string): Error {
  if (error instanceof McpError) return error;
  if (isAuthHandoffError(error) && error instanceof Error) return error;
  const detail = hasErrorDetails(error) && error.details
    ? `${error.message}: ${error.details}`
    : describeApiError(error);
  return new McpError(ErrorCode.InternalError, `${fallbackContext}: ${detail}`);
}
