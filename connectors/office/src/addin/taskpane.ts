/**
 * Office Add-in taskpane entry script.
 * Initializes Office.js, connects to the sidecar via WebSocket, dispatches
 * incoming commands to Word command handlers, and updates the minimal status UI.
 *
 * Runs in the Office WebView (browser context). No React — plain DOM.
 */

import { SidecarWebSocketClient, type ConnectionState, type CommandHandler, type SidecarConfig } from './websocket.js';
import { getWordCommandHandler } from './commands/wordCommands.js';
import { getExcelCommandHandler } from './commands/excelCommands.js';
import { getPowerpointCommandHandler } from './commands/powerpointCommands.js';
import type { OfficeApp } from '../shared/office/protocol.js';

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

// ---------------------------------------------------------------------------
// UI helpers
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
  });
}

if (typeof Office !== 'undefined' && typeof Office.onReady === 'function') {
  initializeTaskpane();
}
