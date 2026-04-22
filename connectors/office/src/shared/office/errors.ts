/**
 * Office sidecar error adapter — Stage 8.
 *
 * Thin wrapper around `@core/appBridge/shared/errors`. The shared `ErrorCode`
 * enum is the single source of truth for wire-format codes across the
 * browser-extension bridge and the Office sidecar; Office keeps its own
 * message templates (e.g. `"Word isn't connected. Open a document in
 * Microsoft Word..."`) as wrappers around the shared enum.
 *
 * `SidecarHttpError` + `buildErrorResponse()` continue to be the unit Office's
 * HTTPS request handler emits; only the type of `.code` flips from a local
 * literal union to the shared `ErrorCode`.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import {
  type AppBridgeError,
  ErrorCode,
} from '../appBridge/shared/errors.js';
import type { OfficeApp } from './protocol.js';

/**
 * Backwards-compat alias. Previously a Office-local literal union; now the
 * shared enum. Kept so downstream `SidecarErrorCode` imports keep working.
 */
export type SidecarErrorCode = ErrorCode;

/**
 * Backwards-compat constant map. Previously `SIDECAR_ERROR_CODES.appNotConnected`
 * was the Office-local literal; now it's the shared `ErrorCode` enum member.
 * Wire-format codes are unchanged (`'UNAUTHORIZED'`, `'INVALID_REQUEST'`, ...).
 */
export const SIDECAR_ERROR_CODES = {
  unauthorized: ErrorCode.UNAUTHORIZED,
  invalidRequest: ErrorCode.INVALID_REQUEST,
  appNotConnected: ErrorCode.APP_NOT_CONNECTED,
  addinDisconnected: ErrorCode.ADDIN_DISCONNECTED,
  commandTimeout: ErrorCode.COMMAND_TIMEOUT,
  internalError: ErrorCode.INTERNAL_ERROR,
} as const;

// ---------------------------------------------------------------------------
// SidecarHttpError — the Office-side exception type
// ---------------------------------------------------------------------------

/**
 * Office-specific Error subclass. Kept because the sidecar's HTTP request
 * handler branches on `instanceof SidecarHttpError` to build the response
 * body (`buildErrorResponse`). The `.code` field is now the shared
 * `ErrorCode`; `.app` carries the Office host for display (optional).
 */
export class SidecarHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly app?: OfficeApp,
  ) {
    super(message);
    this.name = 'SidecarHttpError';
  }
}

// ---------------------------------------------------------------------------
// HTTP response body
// ---------------------------------------------------------------------------

export interface ErrorResponseBody {
  success: false;
  error: string;
  code: ErrorCode;
  app?: OfficeApp;
}

export function buildErrorResponse(error: SidecarHttpError): ErrorResponseBody {
  return {
    success: false,
    error: error.message,
    code: error.code,
    ...(error.app ? { app: error.app } : {}),
  };
}

// ---------------------------------------------------------------------------
// Office-specific error factories (brand-voice messages)
// ---------------------------------------------------------------------------

type AppErrorDetails = {
  label: string;
  openInstruction: string;
};

const APP_ERROR_DETAILS: Record<OfficeApp, AppErrorDetails> = {
  word: {
    label: 'Word',
    openInstruction: 'Open a document in Microsoft Word',
  },
  excel: {
    label: 'Excel',
    openInstruction: 'Open a workbook in Microsoft Excel',
  },
  powerpoint: {
    label: 'PowerPoint',
    openInstruction: 'Open a presentation in Microsoft PowerPoint',
  },
};

export function createUnauthorizedError(): SidecarHttpError {
  return new SidecarHttpError(401, ErrorCode.UNAUTHORIZED, 'Unauthorized');
}

export function createInvalidRequestError(message: string): SidecarHttpError {
  return new SidecarHttpError(400, ErrorCode.INVALID_REQUEST, message);
}

export function createInternalError(message = 'Internal error'): SidecarHttpError {
  return new SidecarHttpError(500, ErrorCode.INTERNAL_ERROR, message);
}

export function createAppNotConnectedError(app: OfficeApp): SidecarHttpError {
  const details = APP_ERROR_DETAILS[app];
  const message = `${details.label} isn't connected. ${details.openInstruction} with the Rebel add-in enabled, then try again.`;
  return new SidecarHttpError(503, ErrorCode.APP_NOT_CONNECTED, message, app);
}

export function createAddinDisconnectedError(app: OfficeApp): SidecarHttpError {
  const details = APP_ERROR_DETAILS[app];
  return new SidecarHttpError(
    503,
    ErrorCode.ADDIN_DISCONNECTED,
    `${details.label} disconnected while executing the command. Please reopen the document and try again.`,
    app,
  );
}

export function createCommandTimeoutError(app: OfficeApp): SidecarHttpError {
  return new SidecarHttpError(
    504,
    ErrorCode.COMMAND_TIMEOUT,
    'The operation timed out. The document may be very large — try a smaller range or limit.',
    app,
  );
}

// ---------------------------------------------------------------------------
// Core-error translation — bridge from @core/appBridge to Office's error type
// ---------------------------------------------------------------------------

/**
 * Runtime guard — detects a core `AppBridgeError` object. Core's
 * `CommandRouter` throws/rejects with these plain objects (see
 * `createAppBridgeError()` in `@core/appBridge/shared/errors`); Office's
 * HTTPS handler expects `SidecarHttpError` to drive `buildErrorResponse`,
 * so we translate at the boundary.
 */
export function isAppBridgeError(value: unknown): value is AppBridgeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    'status' in value &&
    typeof (value as { code: unknown }).code === 'string' &&
    typeof (value as { status: unknown }).status === 'number'
  );
}

/**
 * Convert a core `AppBridgeError` into Office's `SidecarHttpError`. For the
 * three common error codes the shared `CommandRouter` raises
 * (`APP_NOT_CONNECTED`, `ADDIN_DISCONNECTED`, `COMMAND_TIMEOUT`) we swap in
 * Office's brand-voice messages; any other code falls through with the
 * core-supplied message preserved.
 */
export function fromAppBridgeError(
  err: AppBridgeError,
  app?: OfficeApp,
): SidecarHttpError {
  if (app) {
    if (err.code === ErrorCode.APP_NOT_CONNECTED) {
      return createAppNotConnectedError(app);
    }
    if (err.code === ErrorCode.ADDIN_DISCONNECTED) {
      return createAddinDisconnectedError(app);
    }
    if (err.code === ErrorCode.COMMAND_TIMEOUT) {
      return createCommandTimeoutError(app);
    }
  }
  return new SidecarHttpError(err.status, err.code, err.message, app);
}

// ---------------------------------------------------------------------------
// Re-export the shared ErrorCode so Office consumers have a single import site
// ---------------------------------------------------------------------------

export { ErrorCode };
export type { AppBridgeError };
