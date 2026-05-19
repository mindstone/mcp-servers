import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  MicrosoftRefreshDisabledError,
  detectAuthRequiredReason,
  formatGraphError,
} from '@mindstone/mcp-server-microsoft-shared';
import type { AuthRequiredReason } from '@mindstone/mcp-server-microsoft-shared';
import { TeamsBusinessError } from './teams.js';
import { AUTH_TOOL_NAME, REQUEST_TIMEOUT_MS, getMsPackageId } from './types.js';

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

export function errorResponse(payload: ErrorPayload): CallToolResult {
  return {
    content: [{ type: 'text', text: errorJson(payload) }],
    isError: true,
  };
}

export function successJson(data: unknown): string {
  return JSON.stringify(data);
}

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

export function buildErrorResponse(err: unknown): CallToolResult {
  if (err instanceof TeamsBusinessError) {
    return errorResponse({
      error: err.message,
      action_required: 'Adjust the arguments per the message above and try again.',
      next_step: err.nextStep,
    });
  }
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
  return errorResponse({
    error: formatGraphError(err),
    action_required:
      'Retry the call. If it continues to fail, run authenticate_microsoft_account to refresh the connection.',
    next_step: AUTH_TOOL_NAME,
  });
}

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

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
