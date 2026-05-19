import type { FetchExceptionShape, IntentOp } from './diagnostics.js';

/**
 * Canonical shared-chat error codes.
 *
 * Includes:
 * - All legacy browser-extension / Office error-code values (F28)
 * - Stage 1 bridge-status mapper values
 */
export const ALL_CHAT_ERROR_CODES = [
  // Legacy extension + Office enums
  'NOT_IMPLEMENTED',
  'NOT_FOUND',
  'APP_NOT_CONNECTED',
  'PORT_UNREACHABLE',
  'NETWORK_ERROR',
  'TIMEOUT',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'INTERNAL_ERROR',
  'UNKNOWN',
  // Stage 0 additions
  'FORBIDDEN',
  'GONE',
  'REVOKED',
  // Stage 1 bridge-status/fetch collapse vocabulary
  'UNSUPPORTED',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_ERROR',
  'ABORTED',
] as const;

export type ChatErrorCode = (typeof ALL_CHAT_ERROR_CODES)[number];

type ResponseMappedCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'GONE'
  | 'UNSUPPORTED'
  | 'BRIDGE_UNAVAILABLE'
  | 'BRIDGE_ERROR'
  | 'UNKNOWN';

const DEFAULT_ERROR_MESSAGES: Record<ResponseMappedCode, string> = {
  BAD_REQUEST: 'Rebel rejected the request.',
  UNAUTHORIZED: 'Pair the extension again in Rebel settings to restore the connection.',
  FORBIDDEN: 'Rebel denied this request.',
  NOT_FOUND: 'This conversation no longer exists in Rebel.',
  GONE: 'This conversation is no longer available.',
  UNSUPPORTED: "Rebel can't take this action yet — the feature is still landing. Please try again soon.",
  BRIDGE_UNAVAILABLE: "Rebel isn't reachable right now. Try again in a moment.",
  BRIDGE_ERROR: 'Rebel returned an unexpected server error.',
  UNKNOWN: 'Rebel returned an unexpected response.',
};

function extractBodyMessage(bodyText: string | null): string | null {
  if (typeof bodyText !== 'string' || bodyText.length === 0) return null;
  try {
    const parsed = JSON.parse(bodyText) as
      | {
          error?: unknown;
          message?: unknown;
        }
      | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.error === 'string' && parsed.error.length > 0) {
      return parsed.error;
    }
    if (parsed.error && typeof parsed.error === 'object') {
      const nestedMessage = (parsed.error as { message?: unknown }).message;
      if (typeof nestedMessage === 'string' && nestedMessage.length > 0) {
        return nestedMessage;
      }
    }
    if (typeof parsed.message === 'string' && parsed.message.length > 0) {
      return parsed.message;
    }
    return null;
  } catch {
    return null;
  }
}

function mapStatusToCode(status: number): ResponseMappedCode {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 410) return 'GONE';
  if (status === 501) return 'UNSUPPORTED';
  if (status === 503) return 'BRIDGE_UNAVAILABLE';
  if (status >= 500 && status <= 599) return 'BRIDGE_ERROR';
  return 'UNKNOWN';
}

export function mapErrorResponse(
  status: number,
  bodyText: string | null,
): { code: ChatErrorCode; message: string } {
  const code = mapStatusToCode(status);
  const message = extractBodyMessage(bodyText);
  return {
    code,
    message: message ?? DEFAULT_ERROR_MESSAGES[code],
  };
}

export function mapFetchException(
  err: unknown,
  op: IntentOp,
): { code: ChatErrorCode; shape: FetchExceptionShape } {
  // Intentionally read and preserve the thrown shape before collapsing to a
  // coarse error code (F22 capture-before-collapse invariant).
  void op;
  const errName = (err as { name?: string })?.name ?? typeof err;
  const errMsg = String((err as { message?: unknown })?.message ?? err).slice(0, 300);
  const constructorName =
    typeof err === 'object' && err !== null
      ? (err as { constructor?: { name?: string } }).constructor?.name
      : undefined;
  const errConstructor =
    typeof err === 'object' && err !== null ? constructorName ?? 'Object' : typeof err;
  const domException =
    typeof DOMException !== 'undefined' && err instanceof DOMException ? err : null;
  const isDOMException = domException !== null;
  const isTypeError = err instanceof TypeError;
  const isAbortError = domException?.name === 'AbortError';

  const shape: FetchExceptionShape = {
    errName,
    errMsg,
    errConstructor,
    isTypeError,
    isDOMException,
    isAbortError,
  };

  if (isAbortError) {
    return { code: 'ABORTED', shape };
  }
  if (domException?.name === 'TimeoutError') {
    return { code: 'TIMEOUT', shape };
  }
  return { code: 'NETWORK_ERROR', shape };
}
