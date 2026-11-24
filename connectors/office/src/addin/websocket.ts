/**
 * WebSocket client for the Office Add-in, connecting to the sidecar bridge.
 * Runs in the Office WebView (browser context) — uses the native WebSocket API.
 */

import type {
  AuthMessage,
  CommandMessage,
  OfficeApp,
  PongMessage,
  RegisterMessage,
  ResponseErrorMessage,
  ResponseSuccessMessage,
  SidecarToAddinMessage,
} from '../shared/office/protocol.js';
import { z } from 'zod';
import type { RegisteredAck } from '../shared/appBridge/shared/protocol.js';

export interface SidecarCredential {
  noteRejected(sentToken: string): Promise<'changed' | 'unchanged' | 'unknown'>;
}

const registeredAckSchema: z.ZodType<RegisteredAck> = z.object({
  type: z.literal('registered'), sessionId: z.string().trim().min(1),
  acceptedCapabilities: z.array(z.string().min(1)),
  serverProtocolVersion: z.literal('1.0'), minClientProtocolVersion: z.literal('1.0'),
});
const commandSchema = z.object({
  type: z.literal('command'), id: z.string().min(1),
  action: z.string().min(1), params: z.record(z.unknown()),
});

export type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

export interface SidecarConfig {
  port: number;
  token: string;
  /**
   * Optional App Bridge connection details injected by the sidecar. When
   * present, the task pane wires up the embedded chat (Stage 8 of
   * `260421_embedded_chat_in_extension.md`). When absent, the chat UI
   * stays in a "not-ready" state and the sidecar WS + command relay
   * continue to work unchanged.
   */
  /**
   * `true` once the sidecar has successfully minted a paired app token
   * with the bridge at taskpane-HTML-serve time. The task-pane uses this
   * as a pre-flight gate — when false we render the "Rebel is setting up"
   * state instead of attempting a first call and seeing it fail. The
   * paired token itself is NEVER sent into the task-pane; all `/intent/*`
   * calls go through the sidecar's proxy which holds the token server-
   * side.
   */
  bridgeReady?: boolean;
}

export type CommandHandler = (
  action: string,
  params: Record<string, unknown>,
) => Promise<{ success: true; data: unknown } | { success: false; error: string; code?: string }>;

export type StateChangeListener = (state: ConnectionState) => void;

const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ELAPSED_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 2_000;

export class SidecarWebSocketClient {
  private socket: WebSocket | null = null;
  private _state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private firstReconnectAttemptAt: number | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectInFlight = false;
  private gaveUp = false;
  private disposed = false;

  private readonly app: OfficeApp;
  private readonly version: string;
  private readonly config: SidecarConfig;
  private readonly onCommand: CommandHandler;
  private readonly onStateChange: StateChangeListener;
  private readonly onGaveUp: (() => void) | undefined;
  private readonly maxReconnectElapsedMs: number;
  private readonly credential: SidecarCredential | undefined;

  constructor(options: {
    app: OfficeApp;
    version: string;
    config: SidecarConfig;
    onCommand: CommandHandler;
    onStateChange: StateChangeListener;
    onGaveUp?: () => void;
    maxReconnectElapsedMs?: number;
    credential?: SidecarCredential;
  }) {
    this.app = options.app;
    this.version = options.version;
    this.config = options.config;
    this.credential = options.credential;
    this.onCommand = options.onCommand;
    this.onStateChange = options.onStateChange;
    this.onGaveUp = options.onGaveUp;
    this.maxReconnectElapsedMs = options.maxReconnectElapsedMs ?? DEFAULT_MAX_RECONNECT_ELAPSED_MS;
  }

  get state(): ConnectionState {
    return this._state;
  }

  async connect(force = false): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (force) {
      this.reconnectAttempts = 0;
      this.firstReconnectAttemptAt = undefined;
      this.gaveUp = false;
      this.clearReconnectTimer();
    }

    if (this.socket || this.connectInFlight) {
      return;
    }

    this.setState('connecting');
    this.connectInFlight = true;

    try {
      const healthy = await this.probeHealth();
      if (!healthy) {
        this.setState('disconnected');
        if (!this.disposed) {
          if (force) {
            this.giveUp();
          } else {
            this.scheduleReconnect();
          }
        }
        return;
      }

      if (this.disposed || this.socket) {
        return;
      }

      // Derive protocol from page — wss:// when served over HTTPS (Office requirement)
      const wsProtocol = typeof window !== 'undefined' && window.location?.protocol === 'https:' ? 'wss' : 'ws';
      const host = typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : 'localhost';
      const url = `${wsProtocol}://${host}:${this.config.port}/ws`;
      let socket: WebSocket;

      try {
        socket = new WebSocket(url);
      } catch {
        console.error('[rebel-addin] Failed to create WebSocket');
        this.setState('disconnected');
        if (!this.disposed) {
          this.scheduleReconnect();
        }
        return;
      }

      this.socket = socket;
      let sentToken = '';

      socket.onopen = () => {
        if (this.disposed || socket !== this.socket) return;
        this.setState('authenticating');

        // First message: auth token
        sentToken = this.config.token;
        const authMsg: AuthMessage = { type: 'auth', token: sentToken };
        socket.send(JSON.stringify(authMsg));

        // Second message: register as Word add-in
        const registerMsg: RegisterMessage = {
          type: 'register',
          app: this.app,
          version: this.version,
        };
        socket.send(JSON.stringify(registerMsg));

        this.firstReconnectAttemptAt ??= Date.now();
        this.clearReconnectTimer();
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (!this.disposed && socket === this.socket) this.setState('disconnected');
        }, Math.max(0, this.maxReconnectElapsedMs - (Date.now() - this.firstReconnectAttemptAt)));
      };

      socket.onmessage = (event) => {
        if (!this.disposed && socket === this.socket) this.handleMessage(String(event.data), socket);
      };

      socket.onclose = (event) => {
        if (this.disposed || socket !== this.socket) return;
        this.socket = null;
        this.clearReconnectTimer();
        this.setState('disconnected');

        if (event.code === 4001 && this.credential) {
          void this.credential.noteRejected(sentToken).then(() => {
            if (!this.disposed && this.socket === null && !this.connectInFlight) this.scheduleReconnect();
          });
        } else if (!this.disposed) {
          this.scheduleReconnect();
        }
      };

      socket.onerror = () => {
        // onclose fires after onerror — reconnection is handled there
      };
    } finally {
      this.connectInFlight = false;
    }
  }

  disconnect(): void {
    this.disposed = true;
    this.clearReconnectTimer();

    if (this.socket) {
      this.socket.close(1000, 'Client disconnecting');
      this.socket = null;
    }

    this.setState('disconnected');
  }

  private setState(newState: ConnectionState): void {
    if (this._state === newState) {
      return;
    }
    const oldState = this._state;
    this._state = newState;
    console.log(`[rebel-addin] Connection: ${oldState} → ${newState}`);
    this.onStateChange(newState);
  }

  private handleMessage(raw: string, socket: WebSocket): void {
    let message: SidecarToAddinMessage;
    try {
      message = JSON.parse(raw) as SidecarToAddinMessage;
    } catch {
      console.warn('[rebel-addin] Received invalid JSON from sidecar');
      return;
    }

    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      console.warn('[rebel-addin] Received malformed message from sidecar');
      return;
    }

    if (registeredAckSchema.safeParse(message).success) {
      this.acceptRegistration();
      return;
    }
    switch (message.type) {
      case 'command':
        if (commandSchema.safeParse(message).success) {
          this.acceptRegistration();
          void this.dispatchCommand(message as CommandMessage, socket);
        }
        break;
      case 'ping': {
        const pong: PongMessage = { type: 'pong' };
        socket.send(JSON.stringify(pong));
        break;
      }
      default:
        console.warn('[rebel-addin] Unknown message type:', message.type);
    }
  }

  private acceptRegistration(): void {
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.firstReconnectAttemptAt = undefined;
    this.gaveUp = false;
    this.setState('connected');
  }

  private async dispatchCommand(command: CommandMessage, socket: WebSocket): Promise<void> {
    try {
      const result = await this.onCommand(command.action, command.params);
      if (this.disposed || socket !== this.socket) return;

      if (result.success) {
        const response: ResponseSuccessMessage = {
          type: 'response',
          id: command.id,
          success: true,
          data: result.data,
        };
        socket.send(JSON.stringify(response));
      } else {
        const response: ResponseErrorMessage = {
          type: 'response',
          id: command.id,
          success: false,
          error: result.error,
          ...(result.code ? { code: result.code } : {}),
        };
        socket.send(JSON.stringify(response));
      }
    } catch (error) {
      if (this.disposed || socket !== this.socket) return;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const response: ResponseErrorMessage = {
        type: 'response',
        id: command.id,
        success: false,
        error: errorMsg,
        code: 'ADDIN_EXECUTION_ERROR',
      };
      socket.send(JSON.stringify(response));
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const now = Date.now();
    if (this.firstReconnectAttemptAt === undefined) {
      this.firstReconnectAttemptAt = now;
    }

    if (now - this.firstReconnectAttemptAt >= this.maxReconnectElapsedMs) {
      this.giveUp();
      return;
    }

    const delay = Math.min(
      MIN_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
      this.maxReconnectElapsedMs - (now - this.firstReconnectAttemptAt),
    );

    this.reconnectAttempts += 1;
    console.log(`[rebel-addin] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (Date.now() - this.firstReconnectAttemptAt! >= this.maxReconnectElapsedMs) {
        this.giveUp();
        return;
      }
      void this.connect();
    }, delay);
  }

  private async probeHealth(): Promise<boolean> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => {
      controller?.abort();
    }, HEALTH_CHECK_TIMEOUT_MS);

    try {
      const httpProtocol = typeof window !== 'undefined' && window.location?.protocol === 'https:' ? 'https' : 'http';
      const host = typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : 'localhost';
      const response = await fetch(`${httpProtocol}://${host}:${this.config.port}/health`, {
        signal: controller?.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private giveUp(): void {
    this.clearReconnectTimer();
    if (this.gaveUp) {
      return;
    }

    this.gaveUp = true;
    this.onGaveUp?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
