import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  MicrosoftRefreshDisabledError,
  detectAuthRequiredReason,
  formatGraphError,
} from '@mindstone/mcp-server-microsoft-shared';
import type { AuthRequiredReason } from '@mindstone/mcp-server-microsoft-shared';
import { AUTH_TOOL_NAME, REQUEST_TIMEOUT_MS, getMsPackageId } from './types.js';

/**
 * Compose a per-call abort signal with the cohort timeout.
 *
 * Returns an AbortSignal that fires when EITHER the caller's signal aborts
 * OR `REQUEST_TIMEOUT_MS` elapses, whichever is sooner.
 */
export function abortableSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!callerSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  const controller = new AbortController();
  const onAbort = (reason: unknown) => controller.abort(reason);
  if (callerSignal.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    callerSignal.addEventListener('abort', () => onAbort(callerSignal.reason), { once: true });
  }
  if (timeoutSignal.aborted) {
    controller.abort(timeoutSignal.reason);
  } else {
    timeoutSignal.addEventListener('abort', () => onAbort(timeoutSignal.reason), { once: true });
  }
  return controller.signal;
}

export function extractCallerSignal(extra: unknown): AbortSignal | undefined {
  if (extra && typeof extra === 'object' && 'signal' in extra) {
    const signal = (extra as { signal?: unknown }).signal;
    if (signal instanceof AbortSignal) return signal;
  }
  return undefined;
}

/**
 * Race a promise against an AbortSignal as defence-in-depth.
 *
 * The composed signal is the primary cancellation mechanism: callers thread it
 * into each Graph request via `GraphRequest.options({ signal })` so the
 * underlying `fetch` is actually aborted on caller cancel or cohort timeout.
 * This wrapper guarantees the tool call returns promptly even if some
 * middleware path drops the signal — in that case the background fetch is
 * left to settle silently while the host-visible timeout contract is honoured.
 */
export function runWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Request aborted'));
      return;
    }
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new Error('Request aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Host-orchestrated auth_required envelope. The OSS server emits structural-only
 * payload — no URL, no port — and the host computes the OAuth URL.
 *
 * Mirrors Slack/Google Workspace cohort precedent.
 */
export function buildAuthRequiredResponse(): Record<string, unknown> {
  return {
    status: 'auth_required',
    user_action: { id: 'microsoft.connect_account' },
    agent_action: {
      instruction:
        "Connect your Microsoft 365 account to continue. The user will be redirected to Microsoft's sign-in.",
    },
    setupToolName: AUTH_TOOL_NAME,
  };
}

export function authRequiredJson(): string {
  return JSON.stringify(buildAuthRequiredResponse());
}

export interface ErrorPayload {
  error: string;
  action_required: string;
  next_step: string;
  reason?: string;
  [key: string]: unknown;
}

function errorJson(payload: ErrorPayload): string {
  return JSON.stringify({ ok: false, ...payload });
}

/**
 * Build a CallToolResult for a manual validation / business-rule rejection.
 * Mirrors bundled microsoft-mail's `errorResult` parity: `isError: true` plus
 * `{ ok: false, error, action_required, next_step }` payload.
 */
export function errorResponse(payload: ErrorPayload): CallToolResult {
  return {
    content: [{ type: 'text', text: errorJson(payload) }],
    isError: true,
  };
}

/**
 * Encode a successful tool result as plain JSON, matching bundled
 * microsoft-mail's `successResult` parity (no `ok: true` wrapper).
 */
export function successJson(data: unknown): string {
  return JSON.stringify(data);
}

/**
 * Recursively look through `cause`/`error`/`originalError` chains for a token-
 * refresh-disabled signal. The Microsoft Graph SDK wraps middleware throws so
 * the original `MicrosoftRefreshDisabledError` may be nested.
 */
function isRefreshDisabledError(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 6 && cursor != null; depth += 1) {
    if (cursor instanceof MicrosoftRefreshDisabledError) return true;
    if (typeof cursor === 'object') {
      const obj = cursor as { code?: unknown; cause?: unknown; originalError?: unknown };
      if (obj.code === 'MICROSOFT_REFRESH_DISABLED') return true;
      cursor = obj.cause ?? obj.originalError;
      continue;
    }
    break;
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes('Microsoft token refresh is disabled by host')) return true;
    if (msg.includes('host has disabled refresh')) return true;
  }
  return false;
}

function detectTokenProviderAuthReason(err: unknown): AuthRequiredReason | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message.toLowerCase();
  if (msg.includes('microsoft token expired')) return 'token_expired';
  return null;
}

/**
 * Map a Microsoft Graph error / shared TokenProvider error into the right
 * tool response. Returns `auth_required` for token-related failures, the
 * generic recovery-guidance envelope otherwise.
 */
export function buildErrorResponse(err: unknown): CallToolResult {
  if (isRefreshDisabledError(err)) {
    return {
      content: [{ type: 'text', text: authRequiredJson() }],
      isError: true,
    };
  }
  const reason = detectAuthRequiredReason(err) ?? detectTokenProviderAuthReason(err);
  if (reason) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...buildAuthRequiredResponse(),
            reason,
            error: formatGraphError(err),
            package_id: getMsPackageId(),
          }),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: errorJson({
          error: formatGraphError(err),
          action_required:
            'Retry the call. If it continues to fail, run authenticate_microsoft_account to refresh the connection.',
          next_step: AUTH_TOOL_NAME,
        }),
      },
    ],
    isError: true,
  };
}

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wrap a tool handler with consistent error handling. Handlers return either
 * a CallToolResult (for already-shaped responses, e.g. validation errors) or
 * a JSON string. ConnectorErrors and Graph 401/refresh failures translate to
 * the structured `auth_required` shape via {@link buildErrorResponse}.
 */
export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string | CallToolResult>,
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      const result = await fn(args, extra);
      if (typeof result === 'string') {
        return { content: [{ type: 'text', text: result }] };
      }
      return result;
    } catch (err) {
      return buildErrorResponse(err);
    }
  };
}

export type { AuthRequiredReason };
