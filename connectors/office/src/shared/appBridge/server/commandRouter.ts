/**
 * CommandRouter — correlation-ID router from bridge to a connected app (Stage 3).
 *
 * Delivers:
 *   - `dispatch({ appId, capability, payload, prevCommandId?, timeoutMs? })`
 *     → generates a `commandId`, serialises the `command` message, sends over
 *     WS, and returns a promise that resolves when the matching `response`
 *     arrives or rejects on timeout / disconnect / idempotent-drop.
 *   - `routeCommand(appId, action, params)` — legacy Stage 1 signature, now
 *     delegates to `dispatch` internally so Office-style consumers keep
 *     working when they import this class.
 *   - `handleResponse(msg)` — correlates by `commandId`; discards late
 *     responses with a WARN log + marks the entry in the recent-history
 *     cache so retries with `prevCommandId` are rejected with IDEMPOTENT_DROP
 *     (R19 / D22).
 *   - `rejectPending(appId, code)` — iterates pending and rejects entries
 *     bound to `appId`. Also supports the legacy name `rejectPendingForApp`.
 *
 * Recent-history cache:
 *   - TTL = 2 × `timeoutMs`, configurable at construction via
 *     `recentHistoryTtlMs`.
 *   - Stores `{ expiresAt, wasLateResponse, appId, capability }` keyed by
 *     `commandId` so a caller's `prevCommandId` can be matched against
 *     already-delivered commands AND already-timed-out commands.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { randomUUID } from 'node:crypto';
// Vendored minimal logger/reporter shapes — pino / @core/errorReporter are not
// shipped with this package; we only need the type surface CommandRouter uses.
type Logger = { warn: (...args: unknown[]) => void };
type ErrorReporter = {
  addBreadcrumb: (breadcrumb: {
    category: string;
    message: string;
    level?: string;
    data?: Record<string, unknown>;
  }) => void;
};
import { createAppBridgeError, ErrorCode } from '../shared/errors.js';
import type {
  AppType,
  CommandMessage,
  ResponseMessage,
  TabContext,
} from '../shared/protocol.js';
import type { ConnectionManager } from './connectionManager.js';

export type CommandResult =
  | { success: true; data: unknown; commandId: string }
  | {
      success: false;
      error: string;
      code?: string;
      details?: Record<string, unknown>;
      commandId: string;
    };

interface PendingRequest<TApp extends string> {
  app: TApp;
  capability: string;
  commandId: string;
  prevCommandId: string | undefined;
  timeout: NodeJS.Timeout;
  settled: boolean;
  resolve: (value: CommandResult) => void;
  reject: (error: Error) => void;
}

/**
 * Status sentinel returned by the recent-history cache (kept public so tests
 * can assert the late-response / idempotent-drop flow).
 */
export type RecentCommandLookup =
  | { kind: 'unknown' }
  | { kind: 'expired'; wasLateResponse: boolean; appId: string; capability: string }
  | { kind: 'pending'; appId: string; capability: string };

interface RecentHistoryEntry<TApp extends string> {
  appId: TApp;
  capability: string;
  expiresAt: number;
  /** Flipped to `true` when a response arrives after the pending promise was cancelled. */
  wasLateResponse: boolean;
}

export interface CommandRouterOptions {
  /** Per-command timeout in ms. Default 30 s. */
  timeoutMs?: number;
  /** Recent-history TTL in ms. Default `2 × timeoutMs`. */
  recentHistoryTtlMs?: number;
  /** Clock for tests. */
  now?: () => number;
  /** Optional logger for late-response WARN / idempotent-drop traces (D24). */
  logger?: Logger;
  /**
   * Optional Sentry breadcrumb sink. When present, COMMAND_TIMEOUT fires a
   * breadcrumb the same way pair/origin/security events do — so the Stage 5
   * observability checklist covers the full request lifecycle.
   */
  errorReporter?: ErrorReporter;
}

export interface DispatchArgs<TApp extends string = AppType> {
  appId: TApp;
  capability: string;
  payload: Record<string, unknown>;
  /** Previous commandId from a retry path — used for idempotency (R19 / D22). */
  prevCommandId?: string;
  /** Per-call timeout override. Defaults to the router's configured `timeoutMs`. */
  timeoutMs?: number;
  /**
   * Target browser tab for DOM commands (R18 / D21). Forwarded verbatim in
   * the `command` frame so the extension can validate the tab is still alive
   * before executing. When the extension returns `TAB_CONTEXT_GONE`, we
   * surface it as a distinct error rather than silently retargeting.
   */
  tabContext?: TabContext;
}

export class CommandRouter<TApp extends string = AppType> {
  private readonly pendingRequests = new Map<string, PendingRequest<TApp>>();
  private readonly recentHistory = new Map<string, RecentHistoryEntry<TApp>>();
  private readonly timeoutMs: number;
  private readonly recentHistoryTtlMs: number;
  private readonly now: () => number;
  private readonly logger: Logger | undefined;
  private readonly errorReporter: ErrorReporter | undefined;
  private disposed = false;

  constructor(
    private readonly connectionManager: ConnectionManager<TApp>,
    options: CommandRouterOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.recentHistoryTtlMs = options.recentHistoryTtlMs ?? 2 * this.timeoutMs;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.errorReporter = options.errorReporter;
  }

  /**
   * Send a command and await its response. The canonical Stage 3 entry point.
   *
   * Throws `APP_NOT_CONNECTED` synchronously when no WS is registered for
   * `appId`. Throws `IDEMPOTENT_DROP` when `prevCommandId` references a
   * recent command whose late response was already observed (R19 / D22).
   *
   * Rejects the returned promise on `COMMAND_TIMEOUT` / `ADDIN_DISCONNECTED`
   * / `INTERNAL_ERROR` (e.g., JSON serialisation failure).
   */
  async dispatch(args: DispatchArgs<TApp>): Promise<CommandResult> {
    if (this.disposed) {
      throw createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'CommandRouter is disposed.',
      );
    }

    this.pruneHistory();

    const connection = this.connectionManager.getConnection(args.appId);
    if (!connection) {
      throw createAppBridgeError(ErrorCode.APP_NOT_CONNECTED);
    }

    if (args.prevCommandId) {
      const prev = this.recentHistory.get(args.prevCommandId);
      if (prev && prev.wasLateResponse) {
        this.logger?.warn(
          {
            appId: args.appId,
            capability: args.capability,
            prevCommandId: args.prevCommandId,
          },
          'Idempotent drop — retry arrived after original late-response completed',
        );
        throw createAppBridgeError(
          ErrorCode.IDEMPOTENT_DROP,
          'Retry dropped — the original command completed after a late response.',
        );
      }
    }

    const commandId = randomUUID();
    const timeoutMs = args.timeoutMs ?? this.timeoutMs;
    const message: CommandMessage = {
      type: 'command',
      id: commandId,
      ...(args.prevCommandId !== undefined ? { prevCommandId: args.prevCommandId } : {}),
      action: args.capability,
      params: args.payload,
      // R18 / D21: forward tabContext verbatim so the extension can validate
      // the target tab exists before dispatching DOM handlers. Omit when
      // absent so the wire format stays lean for capabilities that don't
      // need a tab (e.g. `status`).
      ...(args.tabContext !== undefined ? { tabContext: args.tabContext } : {}),
    };

    return await new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onTimeout(commandId);
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      const pending: PendingRequest<TApp> = {
        app: args.appId,
        capability: args.capability,
        commandId,
        prevCommandId: args.prevCommandId,
        timeout: timer,
        settled: false,
        resolve,
        reject,
      };
      this.pendingRequests.set(commandId, pending);

      let sendErr: Error | null = null;
      try {
        connection.socket.send(JSON.stringify(message), (error: Error | undefined) => {
          if (error) {
            this.rejectPendingCommand(commandId, ErrorCode.ADDIN_DISCONNECTED);
          }
        });
      } catch (err) {
        sendErr = err instanceof Error ? err : new Error(String(err));
      }

      if (sendErr) {
        this.rejectPendingCommand(commandId, ErrorCode.ADDIN_DISCONNECTED);
      }
    });
  }

  /**
   * Legacy Stage 1 API. Delegates to `dispatch` — kept for Office
   * compatibility and for existing tests.
   */
  async routeCommand(
    app: TApp,
    action: string,
    params: Record<string, unknown>,
  ): Promise<CommandResult> {
    return await this.dispatch({ appId: app, capability: action, payload: params });
  }

  /**
   * Handle a `response` message from an app. Resolves the matching pending
   * request; when the request already timed out, the response is logged at
   * WARN and the recent-history entry is marked so future retries with
   * `prevCommandId` are IDEMPOTENT_DROPpped (R19 / D22).
   */
  handleResponse(message: ResponseMessage): void {
    const pending = this.pendingRequests.get(message.id);
    if (pending && !pending.settled) {
      pending.settled = true;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);
      this.recordHistory(message.id, pending.app, pending.capability, false);

      if (message.success) {
        pending.resolve({ success: true, data: message.data, commandId: message.id });
        return;
      }

      // R18 / D21: TAB_CONTEXT_GONE is a bridge-level invariant violation —
      // the target tab has closed or navigated between approval and execution.
      // Reject the dispatch promise with a structured AppBridgeError so the
      // relay renders 410 Gone (not 502 Bad Gateway) and MCP surfaces the
      // distinct user-facing copy. Never silently retry on another tab.
      if (message.code === ErrorCode.TAB_CONTEXT_GONE) {
        this.logger?.warn(
          {
            commandId: message.id,
            appId: pending.app,
            capability: pending.capability,
          },
          'Extension reported TAB_CONTEXT_GONE; refusing silent retry on another tab (R18)',
        );
        pending.reject(
          createAppBridgeError(
            ErrorCode.TAB_CONTEXT_GONE,
            message.error,
          ) as unknown as Error,
        );
        return;
      }

      pending.resolve({
        success: false,
        error: message.error,
        ...(message.code ? { code: message.code } : {}),
        ...(message.details ? { details: message.details } : {}),
        commandId: message.id,
      });
      return;
    }

    // Late response: no pending entry. Either the timeout fired already, or
    // the caller has disappeared. Either way, the command is done — log and
    // update the recent-history cache so a retry with prevCommandId can be
    // rejected with IDEMPOTENT_DROP.
    const historical = this.recentHistory.get(message.id);
    if (historical) {
      historical.wasLateResponse = true;
      this.logger?.warn(
        {
          commandId: message.id,
          appId: historical.appId,
          capability: historical.capability,
        },
        'Late response discarded — pending request already expired',
      );
    } else {
      this.logger?.warn(
        { commandId: message.id },
        'Late response discarded — no history for this commandId',
      );
    }
  }

  /**
   * Reject every pending command for `appId` with `code`. Used when the WS
   * closes (`ADDIN_DISCONNECTED`) or shutdown fires (`BRIDGE_NOT_RUNNING` in
   * Stage 5).
   *
   * Accepts the legacy positional-only form for Stage 1 compatibility —
   * existing tests expect `rejectPendingForApp(app)` which maps to this.
   */
  rejectPending(appId: TApp, code: ErrorCode = ErrorCode.ADDIN_DISCONNECTED): void {
    for (const [commandId, pending] of Array.from(this.pendingRequests.entries())) {
      if (pending.app === appId) {
        this.rejectPendingCommand(commandId, code);
      }
    }
  }

  /** Legacy name retained for Stage 1 tests + Office compat. */
  rejectPendingForApp(appId: TApp): void {
    this.rejectPending(appId, ErrorCode.ADDIN_DISCONNECTED);
  }

  dispose(): void {
    this.disposed = true;
    for (const [commandId, pending] of Array.from(this.pendingRequests.entries())) {
      pending.settled = true;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(commandId);
      const err = createAppBridgeError(ErrorCode.INTERNAL_ERROR, 'CommandRouter disposed.');
      pending.reject(err as unknown as Error);
    }
    this.recentHistory.clear();
  }

  /** Exposed for tests. */
  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  /** Exposed for tests. */
  getRecentHistoryTtlMs(): number {
    return this.recentHistoryTtlMs;
  }

  /** Exposed for tests that need to assert empty pending state. */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  /** Exposed for tests — returns a status sentinel for a commandId. */
  lookupRecent(commandId: string): RecentCommandLookup {
    this.pruneHistory();
    const pending = this.pendingRequests.get(commandId);
    if (pending) {
      return { kind: 'pending', appId: pending.app, capability: pending.capability };
    }
    const historical = this.recentHistory.get(commandId);
    if (historical) {
      return {
        kind: 'expired',
        wasLateResponse: historical.wasLateResponse,
        appId: historical.appId,
        capability: historical.capability,
      };
    }
    return { kind: 'unknown' };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private onTimeout(commandId: string): void {
    const pending = this.pendingRequests.get(commandId);
    if (!pending || pending.settled) {
      return;
    }
    pending.settled = true;
    this.pendingRequests.delete(commandId);
    this.recordHistory(commandId, pending.app, pending.capability, false);
    // Stage 5 / R37 — emit a breadcrumb on timeout so Sentry captures the
    // last-seen capability for any downstream exception, and ops can spot
    // timeout clusters. Never include the command payload: tokens and
    // pairing codes would leak into breadcrumb storage.
    this.errorReporter?.addBreadcrumb({
      category: 'app-bridge.command',
      level: 'warning',
      message: 'command-timeout',
      data: {
        appId: pending.app,
        capability: pending.capability,
        timeoutMs: this.timeoutMs,
      },
    });
    pending.reject(
      createAppBridgeError(ErrorCode.COMMAND_TIMEOUT) as unknown as Error,
    );
  }

  private rejectPendingCommand(commandId: string, code: ErrorCode): void {
    const pending = this.pendingRequests.get(commandId);
    if (!pending || pending.settled) {
      return;
    }
    pending.settled = true;
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(commandId);
    this.recordHistory(commandId, pending.app, pending.capability, false);
    pending.reject(createAppBridgeError(code) as unknown as Error);
  }

  private recordHistory(
    commandId: string,
    appId: TApp,
    capability: string,
    wasLateResponse: boolean,
  ): void {
    this.recentHistory.set(commandId, {
      appId,
      capability,
      expiresAt: this.now() + this.recentHistoryTtlMs,
      wasLateResponse,
    });
  }

  private pruneHistory(): void {
    const nowMs = this.now();
    for (const [commandId, entry] of this.recentHistory) {
      if (entry.expiresAt <= nowMs) {
        this.recentHistory.delete(commandId);
      }
    }
  }
}
