/**
 * ConnectionManager — per-app WebSocket registry with heartbeat (Stage 3).
 *
 * Generalised extraction of `packages/office-addin/src/sidecar/connectionManager.ts`.
 * Stage 3 lands the real behaviour:
 *
 *   - `register({ ws, appId, clientId, protocolVersion, capabilities })`
 *     stores a full connection record. If another socket is already bound to
 *     the same `appId`, it's closed with `4003 SUPERSEDED` before the new
 *     registration lands.
 *   - `unregister(appId)` removes the record and emits `'disconnect'`.
 *   - `getByAppId(appId)` / `list()` expose the current connections.
 *   - `startHeartbeat()` / `stopHeartbeat()` manage a 15-second JSON ping
 *     cycle that terminates sockets after the configured number of missed
 *     pongs (default 2 → 30 s idle window).
 *
 * Office keeps its own copy until Stage 8 swaps the import.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
  AppType,
  CapabilityDescriptor,
  PingMessage,
} from '../shared/protocol.js';
import { WS_CLOSE_SUPERSEDED } from '../shared/protocol.js';

/**
 * Snapshot of an authenticated WS session. Keys match the Stage 3 spec so
 * the wsServer, commandRouter, and capabilityRegistry can all rely on the
 * same invariants.
 */
export interface AppConnection<TApp extends string = AppType> {
  appId: TApp;
  clientId: string;
  protocolVersion: string;
  capabilities: readonly CapabilityDescriptor[];
  socket: WebSocket;
  /** Wall-clock ms when the connection became registered. */
  registeredAt: number;
  /** Wire-level identity (legacy alias of `appId`; kept for parity with Office). */
  app: TApp;
  /** Semantic version of the client; optional. */
  version: string;
  /** Pong misses since the last pong. Incremented by the heartbeat loop. */
  missedPongs: number;
}

interface SocketMetadata<TApp extends string> {
  app?: TApp;
}

export interface ConnectionRegisterArgs<TApp extends string = AppType> {
  socket: WebSocket;
  appId: TApp;
  clientId: string;
  protocolVersion: string;
  capabilities: readonly CapabilityDescriptor[];
  /** Optional app-advertised version; defaults to `protocolVersion`. */
  version?: string;
}

export interface ConnectionManagerOptions {
  /** Heartbeat interval in ms (default 15 s). */
  heartbeatIntervalMs?: number;
  /**
   * Miss count that triggers socket termination. Default 2 → 30 s idle window
   * (15 s per tick × 2 misses). Stage 3 spec: "missing pong within 30 s".
   */
  maxMissedPongs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_MISSED_PONGS = 2;

export class ConnectionManager<TApp extends string = AppType> extends EventEmitter {
  private readonly appConnections = new Map<TApp, AppConnection<TApp>>();
  private readonly socketMetadata = new WeakMap<WebSocket, SocketMetadata<TApp>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly maxMissedPongs: number;

  constructor(options: ConnectionManagerOptions = {}) {
    super();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxMissedPongs = options.maxMissedPongs ?? DEFAULT_MAX_MISSED_PONGS;
  }

  /**
   * Register an authenticated WS session for `appId`. Supports three call
   * shapes for callsite clarity (R35 backwards-compat with Stage 1 tests):
   *   - `register(args: ConnectionRegisterArgs)` (Stage 3 canonical)
   *   - `register(appId, version, socket)` (legacy Stage 1 shape)
   */
  register(args: ConnectionRegisterArgs<TApp>): void;
  register(appId: TApp, version: string, socket: WebSocket): void;
  register(
    argsOrAppId: ConnectionRegisterArgs<TApp> | TApp,
    version?: string,
    socket?: WebSocket,
  ): void {
    const args: ConnectionRegisterArgs<TApp> =
      typeof argsOrAppId === 'string'
        ? {
            appId: argsOrAppId,
            // `version` is an optional field — with
            // `exactOptionalPropertyTypes`, we must omit it when undefined
            // rather than set `version: undefined`.
            ...(version !== undefined ? { version } : {}),
            protocolVersion: '1.0',
            clientId: '',
            capabilities: [],
            socket: socket as WebSocket,
          }
        : argsOrAppId;

    const existing = this.appConnections.get(args.appId);
    if (existing && existing.socket !== args.socket) {
      this.disconnect(args.appId, 'supersede');
    }

    const connection: AppConnection<TApp> = {
      appId: args.appId,
      clientId: args.clientId,
      protocolVersion: args.protocolVersion,
      capabilities: [...args.capabilities],
      socket: args.socket,
      registeredAt: Date.now(),
      app: args.appId,
      version: args.version ?? args.protocolVersion,
      missedPongs: 0,
    };

    this.appConnections.set(args.appId, connection);
    this.socketMetadata.set(args.socket, { app: args.appId });
  }

  /**
   * Remove the connection registered under `appId` (or the one tied to a
   * specific `socket` for legacy call sites). Returns the removed connection
   * so callers can dispose resources or log rich context.
   */
  unregister(target: TApp): AppConnection<TApp> | null;
  unregister(target: WebSocket): AppConnection<TApp> | null;
  unregister(target: TApp | WebSocket): AppConnection<TApp> | null {
    let appId: TApp | undefined;
    if (typeof target === 'string') {
      appId = target;
    } else {
      const metadata = this.socketMetadata.get(target);
      if (!metadata?.app) {
        return null;
      }
      const connection = this.appConnections.get(metadata.app);
      if (connection?.socket !== target) {
        return null;
      }
      appId = metadata.app;
    }

    if (!appId) return null;
    const connection = this.appConnections.get(appId);
    if (!connection) {
      return null;
    }
    this.appConnections.delete(appId);
    this.emit('disconnect', appId);
    return connection;
  }

  /** Reset the pong-miss counter for the current connection owning `socket`. */
  markPong(socket: WebSocket): void {
    const metadata = this.socketMetadata.get(socket);
    if (!metadata?.app) {
      return;
    }
    const connection = this.appConnections.get(metadata.app);
    if (!connection || connection.socket !== socket) {
      return;
    }
    connection.missedPongs = 0;
  }

  /**
   * Legacy Stage 1 accessor. Also tolerates sockets that have transitioned
   * into CLOSING / CLOSED state by unregistering them lazily.
   */
  getConnection(app: TApp): AppConnection<TApp> | null {
    const connection = this.appConnections.get(app);
    if (!connection) {
      return null;
    }
    if (connection.socket.readyState !== WebSocket.OPEN) {
      this.disconnect(app, 'socket-not-open');
      return null;
    }
    return connection;
  }

  /** Stage 3 canonical accessor — unwraps to `undefined` (no `null`). */
  getByAppId(app: TApp): AppConnection<TApp> | undefined {
    const connection = this.getConnection(app);
    return connection ?? undefined;
  }

  /** Snapshot of currently-registered app ids (open sockets only). */
  getConnectedAppIds(): readonly TApp[] {
    const out: TApp[] = [];
    for (const [appId, connection] of this.appConnections) {
      if (connection.socket.readyState === WebSocket.OPEN) {
        out.push(appId);
      }
    }
    return out;
  }

  /** Array snapshot of every current connection. */
  list(): readonly AppConnection<TApp>[] {
    const out: AppConnection<TApp>[] = [];
    for (const [, connection] of this.appConnections) {
      if (connection.socket.readyState === WebSocket.OPEN) {
        out.push(connection);
      }
    }
    return out;
  }

  /**
   * Snapshot of every live connection whose `clientId` matches the given
   * value. Used by `revokePairedClient` so the desktop can close the
   * extension's live socket at the same time its token is invalidated
   * (post-review B1 — without this, a revoked extension kept answering
   * heartbeats until the next reconnect).
   */
  findByClientId(clientId: string): readonly AppConnection<TApp>[] {
    if (typeof clientId !== 'string' || clientId.length === 0) {
      return [];
    }
    const out: AppConnection<TApp>[] = [];
    for (const connection of this.appConnections.values()) {
      if (
        connection.clientId === clientId &&
        connection.socket.readyState === WebSocket.OPEN
      ) {
        out.push(connection);
      }
    }
    return out;
  }

  disconnect(
    appId: TApp,
    reason:
      | 'manual'
      | 'supersede'
      | 'idle-timeout'
      | 'socket-not-open'
      | 'send-failed' = 'manual',
  ): boolean {
    const connection = this.appConnections.get(appId);
    if (!connection) {
      return false;
    }

    this.appConnections.delete(appId);

    try {
      if (reason === 'idle-timeout' || reason === 'send-failed') {
        connection.socket.terminate();
      } else if (reason === 'supersede') {
        connection.socket.close(WS_CLOSE_SUPERSEDED, 'superseded');
      } else if (connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.close(1000, reason);
      }
    } catch {
      // Best-effort close only.
    }

    this.emit('disconnect', appId);
    return true;
  }

  /**
   * Start the 15 s JSON `{ type: 'ping' }` cycle. Idempotent: safe to call
   * multiple times. The first call creates the timer; subsequent calls are
   * no-op.
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
    // Don't keep the event loop alive for tests that forget to stop the bridge.
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  getHeartbeatIntervalMs(): number {
    return this.heartbeatIntervalMs;
  }

  getMaxMissedPongs(): number {
    return this.maxMissedPongs;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sendHeartbeat(): void {
    const ping: PingMessage = { type: 'ping' };
    const payload = JSON.stringify(ping);

    for (const [appId, connection] of this.appConnections) {
      if (connection.socket.readyState !== WebSocket.OPEN) {
        this.disconnect(appId, 'socket-not-open');
        continue;
      }

      if (connection.missedPongs >= this.maxMissedPongs) {
        this.disconnect(appId, 'idle-timeout');
        continue;
      }

      connection.missedPongs += 1;
      try {
        connection.socket.send(payload);
      } catch {
        this.disconnect(appId, 'send-failed');
      }
    }
  }
}
