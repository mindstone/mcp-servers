/**
 * Office Add-in taskpane entry script.
 *
 * Initializes Office.js, connects to the sidecar via WebSocket, dispatches
 * incoming commands to the host's command handlers, and (Stage 8 of
 * `260421_embedded_chat_in_extension.md`) hosts the embedded chat UI that
 * talks directly to Rebel's App Bridge.
 *
 * The chat UI and the sidecar WS share the same bearer token but travel
 * over separate transports:
 *   - The sidecar WS continues to handle capability relay commands
 *     (read/insert doc content etc.) exactly as before.
 *   - The chat UI talks HTTP to the sidecar's `/intent/*` proxy, which
 *     forwards server-to-server to the App Bridge. The sidecar injects
 *     `{ port, token, bridgeReady }` into `__REBEL_SIDECAR_CONFIG`; the
 *     chat UI sits in a "not-ready" state when `bridgeReady !== true`.
 *
 * Runs in the Office WebView (browser context). No React — plain DOM.
 */

import { SidecarWebSocketClient, type ConnectionState, type CommandHandler, type SidecarConfig } from './websocket.js';
import { getWordCommandHandler } from './commands/wordCommands.js';
import { getExcelCommandHandler } from './commands/excelCommands.js';
import { getPowerpointCommandHandler } from './commands/powerpointCommands.js';
import type { OfficeApp } from '../shared/office/protocol.js';
import { createChatUI, type ChatController } from './chatUI.js';
import {
  installTaskpaneDiagnosticGlobal,
  type BridgeConfig,
  type DocumentContext,
  type TaskpaneDiagnosticApi,
} from './chatClient.js';

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Global config that the sidecar can inject when serving the taskpane HTML.
 * The sidecar sets this via a <script> tag before loading taskpane.js.
 */
declare global {
  interface Window {
    __REBEL_SIDECAR_CONFIG?: SidecarConfig;
    __rebelDiag?: TaskpaneDiagnosticApi;
  }
}

/**
 * Resolve sidecar connection config.
 * Priority: injected window global → URL query params → same-origin fallback.
 */
function getSidecarConfig(): SidecarConfig | null {
  // 1. Injected by sidecar when serving the page
  if (window.__REBEL_SIDECAR_CONFIG) {
    return window.__REBEL_SIDECAR_CONFIG;
  }

  // 2. URL query parameters (?port=52100&token=abc123)
  const params = new URLSearchParams(window.location.search);
  const portStr = params.get('port');
  const token = params.get('token');
  if (portStr && token) {
    const port = parseInt(portStr, 10);
    if (!isNaN(port) && port > 0) {
      return { port, token };
    }
  }

  // 3. Derive from the page's own origin (sidecar serves the taskpane)
  const locationPort = parseInt(window.location.port, 10);
  const locationToken = params.get('token');
  if (!isNaN(locationPort) && locationPort > 0 && locationToken) {
    return { port: locationPort, token: locationToken };
  }

  return null;
}

/**
 * Resolve the sidecar-proxy config from the injected `SidecarConfig`.
 * Returns null when the sidecar hasn't finished its first bridge-auth
 * round-trip yet (`bridgeReady !== true`) — in that case the chat UI
 * stays in "not-ready" and surfaces a graceful "Rebel is setting up"
 * prompt instead of attempting a call that will immediately 503.
 *
 * The paired App Bridge token lives entirely inside the sidecar now;
 * the task-pane only holds the sidecar's bearer token (also used for
 * the WebSocket) and calls same-origin `/intent/*` routes that the
 * sidecar proxies to the bridge.
 */
function getBridgeConfig(config: SidecarConfig): BridgeConfig | null {
  if (config.bridgeReady !== true) {
    return null;
  }
  if (!config.token) {
    return null;
  }
  return { sidecarToken: config.token };
}

// ---------------------------------------------------------------------------
// Debug section (legacy status + command log)
// ---------------------------------------------------------------------------

const MAX_LOG_ENTRIES = 5;
const AUTO_PROBE_INTERVAL_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 2_000;

export type TaskpaneState = ConnectionState | 'rebel-closed';

type RetryClient = Pick<SidecarWebSocketClient, 'connect'>;

interface LogEntry {
  action: string;
  success: boolean;
  timestamp: Date;
}

const commandLog: LogEntry[] = [];

function renderTaskpaneState(state: TaskpaneState, doc: Document = document): void {
  const statusEl = doc.getElementById('status');
  const textEl = doc.getElementById('status-text');
  const detailEl = doc.getElementById('status-detail');
  const retryButton = doc.getElementById('retry-connect') as HTMLButtonElement | null;
  if (!statusEl || !textEl || !detailEl || !retryButton) {
    return;
  }

  // Remove all state classes
  statusEl.classList.remove('connected', 'disconnected', 'connecting', 'rebel-closed');
  detailEl.hidden = true;
  detailEl.textContent = '';
  retryButton.hidden = true;

  switch (state) {
    case 'connected':
      statusEl.classList.add('connected');
      textEl.textContent = 'Connected to Rebel';
      break;
    case 'connecting':
    case 'authenticating':
      statusEl.classList.add('connecting');
      textEl.textContent = 'Connecting to Rebel…';
      break;
    case 'disconnected':
      statusEl.classList.add('disconnected');
      textEl.textContent = 'Disconnected — reconnecting…';
      break;
    case 'rebel-closed':
      statusEl.classList.add('rebel-closed');
      textEl.textContent = 'Rebel is closed.';
      detailEl.hidden = false;
      detailEl.textContent = 'Open Rebel to reconnect.';
      retryButton.hidden = false;
      break;
  }
}

function addCommandLogEntry(action: string, success: boolean): void {
  commandLog.unshift({ action, success, timestamp: new Date() });

  // Trim to max entries
  if (commandLog.length > MAX_LOG_ENTRIES) {
    commandLog.length = MAX_LOG_ENTRIES;
  }

  renderCommandLog();
}

function renderCommandLog(): void {
  const logEl = document.getElementById('command-log');
  if (!logEl) {
    return;
  }

  if (commandLog.length === 0) {
    logEl.innerHTML = '<div class="log-empty">No commands yet</div>';
    return;
  }

  logEl.innerHTML = commandLog
    .map((entry) => {
      const icon = entry.success ? '✓' : '✗';
      const iconClass = entry.success ? 'success' : 'failure';
      const time = entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `<div class="log-entry">
        <span class="log-icon ${iconClass}">${icon}</span>
        <span class="log-action">${escapeHtml(entry.action)}</span>
        <span class="log-time">${time}</span>
      </div>`;
    })
    .join('');
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showConfigError(): void {
  const statusEl = document.getElementById('status');
  const textEl = document.getElementById('status-text');
  if (statusEl && textEl) {
    statusEl.classList.remove('connected', 'connecting');
    statusEl.classList.add('disconnected');
    textEl.textContent = 'Configuration missing — check sidecar is running';
  }
  // Make sure the debug panel is visible so users see the config error.
  const debugRoot = document.getElementById('debug');
  const debugPanel = document.getElementById('debug-panel');
  const debugToggle = document.getElementById('debug-toggle');
  if (debugRoot && debugPanel && debugToggle) {
    debugRoot.dataset.open = 'true';
    debugPanel.hidden = false;
    debugToggle.setAttribute('aria-expanded', 'true');
  }
}

function wireDebugToggle(doc: Document = document): void {
  const root = doc.getElementById('debug');
  const toggle = doc.getElementById('debug-toggle');
  const panel = doc.getElementById('debug-panel');
  if (!root || !toggle || !panel) return;

  const setOpen = (open: boolean): void => {
    root.dataset.open = open ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.hidden = !open;
  };

  toggle.addEventListener('click', () => {
    const isOpen = root.dataset.open === 'true';
    setOpen(!isOpen);
  });
}

async function probeHealth(
  fetchImpl: typeof fetch = fetch,
  healthUrl = new URL('/health', window.location.href).toString(),
): Promise<boolean> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = setTimeout(() => {
    controller?.abort();
  }, HEALTH_CHECK_TIMEOUT_MS);

  try {
    const response = await fetchImpl(healthUrl, {
      signal: controller?.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function createTaskpaneController(options: {
  client: RetryClient;
  doc?: Document;
  fetchImpl?: typeof fetch;
  healthUrl?: string;
}): {
  getState: () => TaskpaneState;
  setState: (state: TaskpaneState) => void;
  dispose: () => void;
} {
  const doc = options.doc ?? document;
  const fetchImpl = options.fetchImpl ?? fetch;
  const healthUrl = options.healthUrl ?? new URL('/health', window.location.href).toString();
  let state: TaskpaneState = 'disconnected';
  let autoProbeInterval: ReturnType<typeof setInterval> | null = null;
  let visibilityListenerAttached = false;
  let probeInFlight = false;

  const attemptReconnect = async (): Promise<void> => {
    if (state !== 'rebel-closed' || probeInFlight) {
      return;
    }

    probeInFlight = true;
    try {
      const healthy = await probeHealth(fetchImpl, healthUrl);
      if (!healthy || state !== 'rebel-closed') {
        return;
      }

      setState('connecting');
      await options.client.connect(true);
    } finally {
      probeInFlight = false;
    }
  };

  const handleVisibilityChange = (): void => {
    if (state !== 'rebel-closed' || doc.visibilityState !== 'visible') {
      return;
    }

    void attemptReconnect();
  };

  const stopClosedStateWatchers = (): void => {
    if (autoProbeInterval !== null) {
      clearInterval(autoProbeInterval);
      autoProbeInterval = null;
    }

    if (visibilityListenerAttached) {
      doc.removeEventListener('visibilitychange', handleVisibilityChange);
      visibilityListenerAttached = false;
    }
  };

  const startClosedStateWatchers = (): void => {
    if (autoProbeInterval === null) {
      autoProbeInterval = setInterval(() => {
        void attemptReconnect();
      }, AUTO_PROBE_INTERVAL_MS);
    }

    if (!visibilityListenerAttached) {
      doc.addEventListener('visibilitychange', handleVisibilityChange);
      visibilityListenerAttached = true;
    }
  };

  const setState = (nextState: TaskpaneState): void => {
    if (state === nextState) {
      return;
    }

    const previousState = state;
    state = nextState;

    if (previousState === 'rebel-closed' && nextState !== 'rebel-closed') {
      stopClosedStateWatchers();
    } else if (previousState !== 'rebel-closed' && nextState === 'rebel-closed') {
      startClosedStateWatchers();
    }

    renderTaskpaneState(state, doc);
  };

  const retryButton = doc.getElementById('retry-connect');
  const handleRetryClick = (): void => {
    setState('connecting');
    void options.client.connect(true);
  };

  retryButton?.addEventListener('click', handleRetryClick);

  return {
    getState: () => state,
    setState,
    dispose: () => {
      stopClosedStateWatchers();
      retryButton?.removeEventListener('click', handleRetryClick);
    },
  };
}

// ---------------------------------------------------------------------------
// Document context capture (Stage 8)
// ---------------------------------------------------------------------------

/**
 * Extract a best-effort document context for the embedded chat. The task
 * pane runs inside Word / Excel / PowerPoint — all three expose
 * `Office.context.document.url` when available (sometimes undefined for
 * unsaved files). We also attach the host name so Rebel can reason about
 * which Office app the user is in.
 */
function captureDocumentContext(host: OfficeApp): DocumentContext {
  const ctx: DocumentContext = { host };
  try {
    const url = Office?.context?.document?.url;
    if (typeof url === 'string' && url.length > 0) {
      ctx.url = url;
      // Derive a human title from the path / URL.
      const title = deriveTitleFromUrl(url);
      if (title) ctx.title = title;
    }
  } catch {
    // Office APIs can throw during early init — no-op.
  }
  return ctx;
}

function deriveTitleFromUrl(url: string): string | undefined {
  // Handle both file:// style and http(s) URLs. Office sometimes returns
  // SharePoint / OneDrive URLs (with query strings) and sometimes local
  // file URLs with percent-encoded paths.
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    if (last) {
      try {
        return decodeURIComponent(last);
      } catch {
        return last;
      }
    }
  } catch {
    // Not a well-formed URL — try a naive tail slice.
    const parts = url.split(/[/\\]/).filter((s) => s.length > 0);
    return parts[parts.length - 1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Multi-app detection and command dispatch
// ---------------------------------------------------------------------------

/** Map of Office host types to our app identifiers and command lookup functions. */
type CommandLookup = (action: string) => ((params: Record<string, unknown>) => Promise<{ success: true; data: unknown } | { success: false; error: string; code?: string }>) | null;

const HOST_TO_APP: Record<string, { app: OfficeApp; getHandler: CommandLookup }> = {
  Word: { app: 'word', getHandler: getWordCommandHandler },
  Excel: { app: 'excel', getHandler: getExcelCommandHandler },
  PowerPoint: { app: 'powerpoint', getHandler: getPowerpointCommandHandler },
};

function createCommandDispatcher(getHandler: CommandLookup): CommandHandler {
  return async (action, params) => {
    const handler = getHandler(action);

    if (!handler) {
      const result = { success: false as const, error: `Unknown command: ${action}`, code: 'UNKNOWN_COMMAND' };
      addCommandLogEntry(action, false);
      return result;
    }

    const result = await handler(params);
    addCommandLogEntry(action, result.success);
    return result;
  };
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initializeTaskpane(): void {
  wireDebugToggle();
  installTaskpaneDiagnosticGlobal(window);

  Office.onReady((info) => {
    console.log(`[rebel-addin] Office.onReady fired — host: ${info.host ?? 'unknown'}`);

    // Detect which Office app is hosting the add-in
    const hostName = info.host ? String(info.host) : undefined;
    const appConfig = hostName ? HOST_TO_APP[hostName] : undefined;

    if (!appConfig) {
      console.error(`[rebel-addin] Unsupported Office host: ${hostName ?? 'unknown'}`);
      showConfigError();
      return;
    }

    console.log(`[rebel-addin] Detected Office app: ${appConfig.app}`);

    const config = getSidecarConfig();

    if (!config) {
      console.error('[rebel-addin] No sidecar config found');
      showConfigError();
      return;
    }

    console.log(`[rebel-addin] Connecting to sidecar on port ${config.port}`);

    // --- Mount the embedded chat UI ----------------------------------------
    // The chat UI is independent of the sidecar WS — it talks HTTP to the
    // App Bridge directly. The sidecar is responsible for injecting
    // bridge config + a paired token; when either is missing we render a
    // "Rebel is setting up" state.
    const chatRoot = document.getElementById('chat-root');
    let chatController: ChatController | null = null;
    if (chatRoot) {
      const bridgeConfig = getBridgeConfig(config);
      const documentContext = captureDocumentContext(appConfig.app);
      chatController = createChatUI({
        container: chatRoot,
        bridgeConfig,
        documentContext,
        getDocumentContext: () => captureDocumentContext(appConfig.app),
      });
    }

    const refreshChatDocumentContext = (): void => {
      chatController?.setDocumentContext(captureDocumentContext(appConfig.app));
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        refreshChatDocumentContext();
      }
    };
    window.addEventListener('focus', refreshChatDocumentContext);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // --- Sidecar WS + command relay (unchanged) ----------------------------
    let controller: ReturnType<typeof createTaskpaneController> | null = null;
    const client = new SidecarWebSocketClient({
      app: appConfig.app,
      version: '1.0.0',
      config,
      onCommand: createCommandDispatcher(appConfig.getHandler),
      onStateChange: (state) => controller?.setState(state),
      onGaveUp: () => controller?.setState('rebel-closed'),
    });

    controller = createTaskpaneController({ client });
    void client.connect();

    // Clean teardown if the pane is unloaded (rare in Office but polite).
    window.addEventListener('beforeunload', () => {
      window.removeEventListener('focus', refreshChatDocumentContext);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      chatController?.dispose();
      controller?.dispose();
    });
  });
}

if (typeof Office !== 'undefined' && typeof Office.onReady === 'function') {
  initializeTaskpane();
}
