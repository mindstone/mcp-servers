import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import {
  MicrosoftRefreshDisabledError,
  createLogger,
  detectAuthRequiredReason,
  formatGraphError,
} from '@mindstone/mcp-server-microsoft-shared';
import type { AuthRequiredReason } from '@mindstone/mcp-server-microsoft-shared';
import { AUTH_TOOL_NAME, REQUEST_TIMEOUT_MS, getMsPackageId } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

const log = createLogger('microsoft-mail-mcp');

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
  next_step?: string;
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
 * Graph rejects a $filter it cannot service efficiently (including $filter
 * combined with $orderby) with HTTP 400 InefficientFilter. Retry and re-auth
 * cannot help — only a simpler query can — so this failure class gets honest
 * guidance instead of the generic retry/re-auth copy below.
 */
function isInefficientFilterError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const graphErr = err as Error & { code?: string };
  const code = (graphErr.code ?? '').toLowerCase();
  const msg = err.message.toLowerCase();
  return code.includes('inefficientfilter') || msg.includes('sort order is too complex');
}

/**
 * Extract the upstream Graph error-body message, mirroring the shared
 * formatGraphError() body parsing. Kept local because the 403 text below must
 * drop the shared package's reconnect advice without forking the formatter.
 */
function extractUpstreamErrorMessage(err: Error): string {
  const graphErr = err as Error & { body?: string };
  if (graphErr.body) {
    try {
      const inner = (JSON.parse(graphErr.body) as { error?: { message?: unknown } })?.error
        ?.message;
      if (typeof inner === 'string' && inner.length > 0) return inner;
    } catch {
      // body is not JSON — fall back to the top-level message
    }
  }
  return err.message;
}

/**
 * Connector-local error text for model-visible non-auth failures.
 *
 * The shared formatGraphError() is not usable as-is on this path:
 *  - it interpolates the upstream Graph error-body message raw, and that text
 *    is attacker-influenceable (invariant #6 requires an untrusted-content
 *    envelope around it), and
 *  - for every HTTP 403 it advises disconnecting and reconnecting the
 *    account. A permissions denial is not repaired by re-authenticating the
 *    same account, and the auth-required branch above already covers the
 *    failures where re-authentication genuinely helps (token expiry, consent,
 *    tenant blocks).
 *
 * Connector-authored messages (plain Errors without a Graph statusCode/body,
 * e.g. the download_attachment validation errors, which already envelope
 * their attacker-controlled fields) pass through untouched so their
 * envelopes stay singular.
 */
function formatGenericGraphError(err: unknown): string {
  if (err instanceof Error) {
    const graphErr = err as Error & { statusCode?: number; code?: string; body?: string };
    if (graphErr.statusCode === 403) {
      const detail = wrapUntrusted(extractUpstreamErrorMessage(err), 'microsoft-mail:graph-error');
      return (
        `${detail} (HTTP 403${graphErr.code ? `: ${graphErr.code}` : ''}). ` +
        'The connected account does not have permission for this operation, or a tenant policy blocks it — ' +
        're-authenticating the same account will not change that. ' +
        'An administrator may need to grant the permission or adjust the policy.'
      );
    }
    if (graphErr.statusCode !== undefined || graphErr.body !== undefined) {
      // Graph SDK error: the formatted text embeds the upstream error-body
      // message, so the whole string is enveloped before it reaches the model.
      return wrapUntrusted(formatGraphError(err), 'microsoft-mail:graph-error') ?? 'Unknown error';
    }
  }
  return formatGraphError(err);
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
            // The shared formatter embeds the upstream Graph error-body
            // message raw for consent/tenant-classified 403s — that text is
            // attacker-influenceable, so it is enveloped before it reaches
            // the model (invariant #6).
            error:
              wrapUntrusted(formatGraphError(err), 'microsoft-mail:graph-error') ?? 'Unknown error',
            package_id: getMsPackageId(),
          }),
        },
      ],
      isError: true,
    };
  }
  // A ZodError here means a Graph response failed boundary validation. Its
  // formatted issues can echo attacker-controlled values (e.g. an unexpected
  // enum value from the mailbox), so never pass the raw message through —
  // report the failure class only, with the offending field paths logged
  // locally for debugging. This branch must run before the InefficientFilter
  // check below: ZodError.message serializes its issues, and an invalid_enum
  // issue embeds the upstream `received` value, so a poisoned enum could
  // otherwise smuggle the filter phrase into the message match and skip this
  // sanitizer entirely.
  if (err instanceof ZodError) {
    log.warn('Microsoft Graph response failed schema validation', {
      paths: err.issues.map((issue) => issue.path.join('.')),
    });
    return errorResponse({
      error:
        'Microsoft Graph returned a response that failed schema validation, so it was not processed.',
      action_required:
        'Retry the call. If it keeps failing, the upstream response shape has changed and the connector needs an update.',
      next_step: 'Retry the same tool call',
    });
  }
  if (isInefficientFilterError(err)) {
    return errorResponse({
      error: formatGenericGraphError(err),
      action_required:
        'Simplify or remove the $filter argument and retry. Microsoft Graph cannot service this filter (for example when combined with a sort order), so retrying as-is or re-authenticating will not help.',
      next_step: 'list_emails',
    });
  }
  // Generic non-auth failure: re-authentication cannot fix filesystem,
  // validation, permission, or unexpected Graph failures, so the guidance
  // must not send the user (or the model) down that path at all — the
  // auth-required branch above handles every case where it genuinely helps.
  return {
    content: [
      {
        type: 'text',
        text: errorJson({
          error: formatGenericGraphError(err),
          action_required:
            'Check the error details and retry the call. If it keeps failing, verify the request arguments and that the mailbox item still exists. Authentication and permission problems are reported separately with their own guidance.',
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
