/**
 * Rebel App Bridge — unified ErrorCode enum and per-surface converters (R9 / D8).
 *
 * One enum, three conversion targets:
 *   - `toHttpStatus()` — HTTP status codes for /intent/* and /apps/*
 *   - `toMcpContent()` — brand-voice strings for MCP tool-call results
 *   - `toWsErrorMessage()` / `toWsCloseCode()` / `toWsCloseReason()` — WebSocket error frames & close codes
 *
 * This keeps every surface consistent: the same underlying failure produces a
 * coherent HTTP status, user-facing MCP text, and WS close code.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import type { ResponseErrorMessage } from './protocol.js';

// ---------------------------------------------------------------------------
// ErrorCode enum
// ---------------------------------------------------------------------------

/**
 * Canonical error codes for the bridge. String constant object + type alias so
 * callers can use `ErrorCode.APP_NOT_CONNECTED` without pulling in a TS `enum`.
 *
 * The type alias deliberately shadows the value via `typeof` — this is the
 * idiomatic zero-runtime-overhead enum pattern also used by this package's
 * Office-facing `SIDECAR_ERROR_CODES` in `src/shared/office/errors.ts`.
 */
export const ErrorCode = {
  APP_NOT_CONNECTED: 'APP_NOT_CONNECTED',
  PAIRING_EXPIRED: 'PAIRING_EXPIRED',
  PAIRING_CONSUMED: 'PAIRING_CONSUMED',
  RATE_LIMITED: 'RATE_LIMITED',
  PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  BAD_REQUEST: 'BAD_REQUEST',
  /**
   * Stage 8 — preserved for Office sidecar wire-format compatibility. Semantically
   * equivalent to `BAD_REQUEST` (both map to HTTP 400); Office's HTTPS API emits
   * `INVALID_REQUEST` and the MCP / add-in consumers may branch on that string,
   * so we keep it distinct rather than silently collapse to `BAD_REQUEST`.
   */
  INVALID_REQUEST: 'INVALID_REQUEST',
  COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  ADDIN_DISCONNECTED: 'ADDIN_DISCONNECTED',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  VERSION_TOO_OLD: 'VERSION_TOO_OLD',
  /**
   * Retry detected — the previous command eventually arrived (late response)
   * so the retry would be a duplicate. R19 / D22 idempotency guard.
   */
  IDEMPOTENT_DROP: 'IDEMPOTENT_DROP',
  /**
   * The requested capability is not advertised by the connected app (or is
   * unknown to the bridge). Stage 4's `/apps/*` relay uses this when a tool
   * is called for an action that the extension never registered.
   */
  CAPABILITY_NOT_SUPPORTED: 'CAPABILITY_NOT_SUPPORTED',
  /**
   * The target surface exists but the browser refuses code injection there
   * (chrome://, extension pages, native PDFs, ...). Distinct from capability
   * absence so user copy can explain "this page can't be automated".
   */
  UNSUPPORTED_SURFACE: 'UNSUPPORTED_SURFACE',
  /**
   * Wrong HTTP verb on an otherwise-valid route (e.g. GET /apps/browser-
   * extension/read_page). Reported by the relay router so MCP clients get a
   * 405 instead of a misleading 400.
   */
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  /**
   * The browser tab a command targeted has closed, navigated, or otherwise
   * disappeared between the moment the agent approved the command and the
   * moment the extension tried to execute it. R18 / D21: the bridge never
   * silently retargets a new tab — closing one tab and opening another must
   * surface as a distinct failure so the user can re-confirm the intent.
   */
  TAB_CONTEXT_GONE: 'TAB_CONTEXT_GONE',
  /**
   * The originally-approved tab still exists, but its location changed
   * (origin+pathname mismatch) before execution. Caller must re-check.
   */
  TAB_CONTEXT_DIVERGED: 'TAB_CONTEXT_DIVERGED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

export interface AppBridgeError {
  code: ErrorCode;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

/** Default user-facing-ish messages; surfaces override via their own converter. */
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  APP_NOT_CONNECTED: 'App is not connected.',
  PAIRING_EXPIRED: 'Pairing code expired.',
  PAIRING_CONSUMED: 'Pairing code already used.',
  RATE_LIMITED: 'Too many attempts. Slow down.',
  PROTOCOL_VERSION_MISMATCH: 'Protocol version mismatch.',
  UNAUTHORIZED: 'Unauthorized.',
  FORBIDDEN: 'Forbidden.',
  BAD_REQUEST: 'Bad request.',
  INVALID_REQUEST: 'Invalid request.',
  COMMAND_TIMEOUT: 'The operation timed out.',
  NOT_IMPLEMENTED: 'Not implemented.',
  INTERNAL_ERROR: 'Internal error.',
  ADDIN_DISCONNECTED: 'Add-in disconnected while executing the command.',
  INVALID_MESSAGE: 'Invalid message.',
  VERSION_TOO_OLD: 'Client version is too old.',
  IDEMPOTENT_DROP:
    'Retry dropped — the original command already completed after a late response.',
  CAPABILITY_NOT_SUPPORTED:
    'The connected app does not advertise that capability.',
  UNSUPPORTED_SURFACE:
    'This browser surface does not allow Rebel to run that action.',
  METHOD_NOT_ALLOWED: 'HTTP method not allowed on this route.',
  TAB_CONTEXT_GONE:
    'The browser tab this command targeted has closed or navigated before it could run.',
  TAB_CONTEXT_DIVERGED:
    'The page changed before this browser action could run.',
};

export function createAppBridgeError(
  code: ErrorCode,
  message?: string,
  details?: Record<string, unknown>,
): AppBridgeError {
  return {
    code,
    message: message ?? DEFAULT_MESSAGES[code],
    status: toHttpStatus(code),
    ...(details ? { details } : {}),
  };
}

// ---------------------------------------------------------------------------
// HTTP status converter
// ---------------------------------------------------------------------------

export function toHttpStatus(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'RATE_LIMITED':
      return 429;
    case 'BAD_REQUEST':
    case 'INVALID_REQUEST':
      return 400;
    case 'NOT_IMPLEMENTED':
      return 501;
    case 'APP_NOT_CONNECTED':
    case 'ADDIN_DISCONNECTED':
      return 503;
    case 'PAIRING_EXPIRED':
    case 'PAIRING_CONSUMED':
      return 410;
    case 'COMMAND_TIMEOUT':
      return 504;
    case 'PROTOCOL_VERSION_MISMATCH':
    case 'VERSION_TOO_OLD':
      return 426;
    case 'INVALID_MESSAGE':
      return 400;
    case 'IDEMPOTENT_DROP':
      // 409 Conflict — the retry conflicts with the already-completed original.
      return 409;
    case 'CAPABILITY_NOT_SUPPORTED':
      return 404;
    case 'UNSUPPORTED_SURFACE':
      return 410;
    case 'METHOD_NOT_ALLOWED':
      return 405;
    case 'TAB_CONTEXT_GONE':
    case 'TAB_CONTEXT_DIVERGED':
      // 410 Gone — the resource (tab) used to exist but is gone. The caller
      // cannot retry safely without re-checking the tab.
      return 410;
    case 'INTERNAL_ERROR':
      return 500;
  }
}

// ---------------------------------------------------------------------------
// MCP content converter
// ---------------------------------------------------------------------------

/**
 * Build an MCP tool-call error result for a given ErrorCode.
 *
 * Voice is Rebel-style: dry, calm, useful. Copy favours clear-over-clever
 * and never shames the user. Labels (`appLabel`) flow through so the same
 * code can say "Browser extension isn't connected" or "Word isn't connected".
 */
export function toMcpContent(
  code: ErrorCode,
  appLabel?: string,
): { isError: true; content: [{ type: 'text'; text: string }] } {
  const text = buildMcpText(code, appLabel);
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

function buildMcpText(code: ErrorCode, appLabel?: string): string {
  const label = appLabel ?? 'The app';
  switch (code) {
    case 'APP_NOT_CONNECTED':
      if (appLabel === 'Browser extension') {
        return `Browser extension isn't connected. Pair it in Settings → Connectors → Rebel App Bridge, then open the tab you want me to see.`;
      }
      return `${label} isn't connected. Pair it in Settings → Connectors, then try again.`;
    case 'ADDIN_DISCONNECTED':
      return `${label} disconnected mid-task. Reopen it and I'll try again.`;
    case 'PAIRING_EXPIRED':
      return `That pairing code expired. Ask for a fresh one in Settings → Connectors.`;
    case 'PAIRING_CONSUMED':
      return `That pairing code has already been used. Generate a new one in Settings → Connectors.`;
    case 'RATE_LIMITED':
      return `Too many attempts in a row. Give it a moment, then try again.`;
    case 'PROTOCOL_VERSION_MISMATCH':
      return `${label} is speaking a protocol I don't understand yet. Update the extension or the desktop app, then reconnect.`;
    case 'VERSION_TOO_OLD':
      return `${label} is an older version that I can't talk to. Update it, then reconnect.`;
    case 'UNAUTHORIZED':
      return `I couldn't authorise that request. Re-pair the app in Settings → Connectors.`;
    case 'FORBIDDEN':
      return `That request isn't allowed from this surface.`;
    case 'BAD_REQUEST':
    case 'INVALID_REQUEST':
      return `Something about that request didn't look right. Please try again.`;
    case 'COMMAND_TIMEOUT':
      return `That took longer than I'll wait. The app may be busy — try a smaller scope or try again.`;
    case 'NOT_IMPLEMENTED':
      return `That capability isn't wired up yet.`;
    case 'INVALID_MESSAGE':
      return `${label} sent a message I couldn't parse. This is usually a version mismatch — try reconnecting.`;
    case 'IDEMPOTENT_DROP':
      return `That retry was a duplicate — the original action already completed.`;
    case 'CAPABILITY_NOT_SUPPORTED':
      return `${label} doesn't support that action right now. Update or reconnect it, then try again.`;
    case 'UNSUPPORTED_SURFACE':
      return `That page doesn't allow browser automation. Open a normal web page and try again.`;
    case 'METHOD_NOT_ALLOWED':
      return `That request used the wrong HTTP method. This is an internal bug — please report it.`;
    case 'TAB_CONTEXT_GONE':
      return `The browser tab this tool targeted has closed or navigated. Ask me to re-check the tab and try again.`;
    case 'TAB_CONTEXT_DIVERGED':
      return `The page changed before I could act. Ask me to re-check the tab and try again.`;
    case 'INTERNAL_ERROR':
      return `Something went wrong on my end. Try again; if it keeps happening, let the Rebel team know.`;
  }
}

// ---------------------------------------------------------------------------
// WebSocket converters
// ---------------------------------------------------------------------------

export function toWsErrorMessage(code: ErrorCode, message?: string): ResponseErrorMessage {
  return {
    type: 'response',
    // Non-correlated errors (e.g. auth failures) use an empty id sentinel;
    // per-command error responses land through CommandRouter with the real id.
    id: '',
    success: false,
    error: message ?? DEFAULT_MESSAGES[code],
    code,
  };
}

/**
 * WebSocket close code for a given error code.
 *
 * 4000–4999 is the application-defined range. Reserved mappings:
 *   4001 UNAUTHORIZED
 *   4002 INVALID_MESSAGE
 *   4010 PROTOCOL_VERSION_MISMATCH
 *   4020 VERSION_TOO_OLD
 *   1011 INTERNAL_ERROR (standard "server error")
 *   1000 normal closure (not reached via this map, but kept as default)
 */
export function toWsCloseCode(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 4001;
    case 'INVALID_MESSAGE':
      return 4002;
    case 'PROTOCOL_VERSION_MISMATCH':
      return 4010;
    case 'VERSION_TOO_OLD':
      return 4020;
    case 'INTERNAL_ERROR':
      return 1011;
    default:
      return 1000;
  }
}

/**
 * Short, human-readable WS close reason. RFC 6455 caps the reason at 123 bytes;
 * keep every string well under that so we never truncate a UTF-8 sequence.
 */
export function toWsCloseReason(code: ErrorCode): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'unauthorized';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'INVALID_MESSAGE':
      return 'invalid message';
    case 'PROTOCOL_VERSION_MISMATCH':
      return 'protocol version mismatch';
    case 'VERSION_TOO_OLD':
      return 'client version too old';
    case 'APP_NOT_CONNECTED':
      return 'app not connected';
    case 'ADDIN_DISCONNECTED':
      return 'app disconnected';
    case 'PAIRING_EXPIRED':
      return 'pairing expired';
    case 'PAIRING_CONSUMED':
      return 'pairing consumed';
    case 'RATE_LIMITED':
      return 'rate limited';
    case 'BAD_REQUEST':
      return 'bad request';
    case 'INVALID_REQUEST':
      return 'invalid request';
    case 'COMMAND_TIMEOUT':
      return 'command timeout';
    case 'NOT_IMPLEMENTED':
      return 'not implemented';
    case 'IDEMPOTENT_DROP':
      return 'idempotent drop';
    case 'CAPABILITY_NOT_SUPPORTED':
      return 'capability not supported';
    case 'UNSUPPORTED_SURFACE':
      return 'unsupported surface';
    case 'METHOD_NOT_ALLOWED':
      return 'method not allowed';
    case 'TAB_CONTEXT_GONE':
      return 'tab context gone';
    case 'TAB_CONTEXT_DIVERGED':
      return 'tab context diverged';
    case 'INTERNAL_ERROR':
      return 'internal error';
  }
}
