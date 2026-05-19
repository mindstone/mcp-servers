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

export function errorJson(payload: ErrorPayload): string {
  return JSON.stringify({ ok: false, ...payload });
}

export function successJson(data: unknown): string {
  return JSON.stringify({ ok: true, ...(data as Record<string, unknown>) });
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
  const reason = detectAuthRequiredReason(err);
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
