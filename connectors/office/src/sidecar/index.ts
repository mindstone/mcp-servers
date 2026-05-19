import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { getHttpsServerOptions } from 'office-addin-dev-certs';
import { ConnectionManager } from '../shared/appBridge/server/connectionManager.js';
import { CommandRouter, type CommandResult } from '../shared/appBridge/server/commandRouter.js';
import { writeStateFile, generateToken } from './auth.js';
import { constantTimeStringEqual } from '../shared/sidecar/constantTime.js';
import {
  installManifestsToWefFolders,
  SIDECAR_PORT_FALLBACKS,
  writeManifest,
  type WefInstallResult,
} from './manifest.js';
import { handleIntentProxy } from './intentProxy.js';
import {
  buildErrorResponse,
  createInternalError,
  createInvalidRequestError,
  createUnauthorizedError,
  fromAppBridgeError,
  isAppBridgeError,
  SidecarHttpError,
} from '../shared/office/errors.js';
import {
  isOfficeApp,
  toOfficeAppId,
  validateRegisterMessage,
  type AddinToSidecarMessage,
  type AuthMessage,
  type OfficeApp,
  type OfficeAppId,
  type ResponseMessage,
} from '../shared/office/protocol.js';

/**
 * Office's HTTP wire format: `{ success, data }` / `{ success, error, code? }`.
 * Core's `CommandResult` adds a `commandId` field; we strip it before writing
 * the response body to preserve the shipped wire shape the MCP server and
 * add-in expect.
 */
type OfficeCommandResult =
  | { success: true; data: unknown }
  | { success: false; error: string; code?: string };

function stripCommandId(result: CommandResult): OfficeCommandResult {
  if (result.success) {
    return { success: true, data: result.data };
  }
  return result.code !== undefined
    ? { success: false, error: result.error, code: result.code }
    : { success: false, error: result.error };
}

const DEFAULT_HOST = '127.0.0.1';
const WS_PATH = '/ws';
const DIAG_TAIL_CAPACITY = 50;
const REQUEST_ID_HEADER_NAME = 'x-rebel-diag-id';

interface DiagTailBuffer {
  record(line: string): void;
  dump(): string[];
}

function createDiagTailBuffer(capacity = DIAG_TAIL_CAPACITY): DiagTailBuffer {
  const safeCapacity = Number.isFinite(capacity) && capacity > 0
    ? Math.floor(capacity)
    : DIAG_TAIL_CAPACITY;
  const ring = new Array<string>(safeCapacity);
  let writeIndex = 0;
  let size = 0;

  return {
    record(line: string) {
      ring[writeIndex] = line;
      writeIndex = (writeIndex + 1) % safeCapacity;
      if (size < safeCapacity) {
        size += 1;
      }
    },
    dump() {
      if (size === 0) return [];
      const start = size === safeCapacity ? writeIndex : 0;
      const out: string[] = [];
      for (let i = 0; i < size; i += 1) {
        out.push(ring[(start + i) % safeCapacity]!);
      }
      return out;
    },
  };
}

function readRequestCorrelationId(
  header: string | string[] | undefined,
): string {
  if (typeof header === 'string') {
    const trimmed = header.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 80) : '-';
  }
  if (Array.isArray(header)) {
    return readRequestCorrelationId(header[0]);
  }
  return '-';
}

// ---------------------------------------------------------------------------
// Content-type map for static file serving
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

type SocketAuthState = {
  authenticated: boolean;
  authTimer: NodeJS.Timeout;
};

export interface StartSidecarOptions {
  host?: string;
  /**
   * Explicit port to bind to (primarily for tests).
   * Omit to use the preferred port list (DEFAULT_SIDECAR_PORT with fallbacks).
   * Pass `0` for a random OS-assigned port (useful for tests in parallel).
   */
  port?: number;
  /**
   * Override the port-try list. If provided, replaces SIDECAR_PORT_FALLBACKS.
   * Ignored when `port` is set.
   */
  portCandidates?: readonly number[];
  stateDirectory?: string;
  commandTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  maxMissedPongs?: number;
  /** Directory containing built add-in static files (taskpane.html, taskpane.js). */
  addinDir?: string;
  /**
   * Whether to install manifests into Office WEF folders on startup.
   * Defaults to true when a stateDirectory is provided. Disable for tests.
   */
  installToWefFolders?: boolean;
  /**
   * Read-timeout for proxied intent streams (ms). Used to fail fast when the
   * bridge socket stalls without ending the SSE response.
   */
  intentProxyStreamReadTimeoutMs?: number;
}

export interface OfficeSidecar {
  port: number;
  token: string;
  pid: number;
  stateFilePath: string;
  manifestPath?: string | undefined;
  wefInstallResults?: WefInstallResult[] | undefined;
  stop: () => Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendFile(res: http.ServerResponse, filePath: string, contentType: string): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

/**
 * Best-effort: read the App Bridge state file and extract the bridge's
 * connection details so the embedded-chat task pane can call `/intent/*`
 * routes directly.
 *
 * The App Bridge writes its state to `userData/mcp/rebel-app-bridge/state.json`.
 * The Office sidecar's state directory is a sibling: `userData/mcp/rebeloffice/`.
 * From the sidecar's perspective, the bridge state file is at:
 *   `<parentOfSidecarStateDir>/rebel-app-bridge/state.json`
 *
 * The file is mode 0o600 — only processes running as the same OS user can
 * read it. Since Rebel spawns the sidecar as a child under the same user,
 * reading this file is a safe way to obtain the router-internal token
 * needed to mint a paired app token via `POST /host/mint-app-token`.
 *
 * Any failure (missing file, parse error, stale pid) returns `null` — the
 * task pane then renders the "Rebel is setting up" state rather than
 * crashing. The chat becomes functional as soon as the bridge is up and
 * the mint round-trip succeeds.
 */
interface AppBridgeStateSnapshot {
  /** Full origin string for the bridge, e.g. `http://127.0.0.1:52320`. */
  bridgeOrigin: string;
  /** Bound port — used as an invalidation key for the minted-token cache. */
  port: number;
  /** ISO timestamp when the bridge started — also used for cache invalidation. */
  startedAt: string;
  /** Router-internal token (file persists a raw copy per `bridge.ts`). */
  routerToken: string;
}

function readAppBridgeState(
  sidecarStateDir: string | undefined,
): AppBridgeStateSnapshot | null {
  if (!sidecarStateDir) return null;
  try {
    const bridgeStateFile = path.join(
      path.dirname(sidecarStateDir),
      'rebel-app-bridge',
      'state.json',
    );
    const raw = fs.readFileSync(bridgeStateFile, 'utf8');
    const parsed = JSON.parse(raw) as {
      port?: unknown;
      pid?: unknown;
      routerToken?: unknown;
      startedAt?: unknown;
    };
    if (typeof parsed.port !== 'number' || parsed.port <= 0) return null;
    if (typeof parsed.routerToken !== 'string' || parsed.routerToken.length === 0) {
      return null;
    }
    if (typeof parsed.startedAt !== 'string' || parsed.startedAt.length === 0) {
      return null;
    }
    return {
      bridgeOrigin: `http://127.0.0.1:${parsed.port}`,
      port: parsed.port,
      startedAt: parsed.startedAt,
      routerToken: parsed.routerToken,
    };
  } catch {
    return null;
  }
}

/**
 * Stable `clientId` persisted in the sidecar's state directory. Keeping it
 * stable across sidecar restarts means we re-mint against the same slot
 * rather than leaking a new entry into the bridge state file every time.
 *
 * Stored as plain text (`office-client-id`) under the sidecar state dir.
 * If the file is missing or unreadable we generate a fresh id and persist
 * it best-effort — a failure to persist just means the next restart gets
 * a new id (harmless, just produces an extra token entry for a few mins
 * until the old one is revoked on next mint).
 */
const OFFICE_CLIENT_ID_FILE = 'office-client-id';

function resolveOfficeClientId(sidecarStateDir: string | undefined): string {
  if (!sidecarStateDir) {
    // No state dir → in-memory only. Still functional; just churns a
    // token slot per restart, but `mintAppTokenForTrustedHost` revokes
    // prior tokens by clientId so it's bounded to one slot-per-session.
    return generateOfficeClientId();
  }
  const filePath = path.join(sidecarStateDir, OFFICE_CLIENT_ID_FILE);
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (raw.length > 0 && raw.length < 200) {
      return raw;
    }
  } catch {
    // Fall through to generation.
  }
  const generated = generateOfficeClientId();
  try {
    fs.mkdirSync(sidecarStateDir, { recursive: true });
    fs.writeFileSync(filePath, generated, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Best-effort — still return the id so minting works this session.
  }
  return generated;
}

function generateOfficeClientId(): string {
  // Short human-readable prefix + 16 hex chars of entropy; matches the
  // shape of browser-extension clientIds loosely.
  return `office-${generateToken().slice(0, 16)}`;
}

/**
 * Module-level cache for the minted bridge app token. The key is the
 * bridge's `(port, startedAt)` pair — if the bridge restarts (different
 * `startedAt` or different `port`), the cache is invalidated and we mint
 * again on the next taskpane HTML request.
 */
interface MintedBridgeToken {
  /** Bridge cache key — re-mint when either field changes. */
  bridgePort: number;
  bridgeStartedAt: string;
  /** The minted paired app token (raw, never persisted). */
  bridgeAppToken: string;
  /** The `clientId` we minted against — required on every `/intent/*` call. */
  bridgeClientId: string;
}

let cachedMintedToken: MintedBridgeToken | null = null;

function invalidateCachedMintedToken(reason: 'unauthorized' | 'revoked'): void {
  if (!cachedMintedToken) return;
  cachedMintedToken = null;
  console.error(`[sidecar-diag] mint-cache.invalidated reason=${reason}`);
}

/**
 * Request a paired app token from the bridge's host-trusted mint route.
 * Returns null on any failure; the task pane then renders a graceful
 * "Rebel is setting up" state rather than crashing.
 */
async function requestMintedAppToken(
  bridge: AppBridgeStateSnapshot,
  clientId: string,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const payload = JSON.stringify({ appId: 'office-addin', clientId });
    const req = http.request(
      `${bridge.bridgeOrigin}/host/mint-app-token`,
      {
        method: 'POST',
        headers: {
          // Host guard requires an explicit loopback Host — the node http
          // client populates this from the URL, which is `127.0.0.1:<port>`.
          Authorization: `Bearer ${bridge.routerToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              ok?: unknown;
              token?: unknown;
            };
            if (body.ok === true && typeof body.token === 'string' && body.token.length > 0) {
              resolve(body.token);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    // Short timeout — the bridge is loopback; 2s is generous.
    req.setTimeout(2_000, () => {
      req.destroy();
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Best-effort: ensure we hold a valid minted app token for the current
 * bridge instance. Reads the bridge state file, checks the cache, and
 * mints a fresh token if needed. Returns null on any failure — the task
 * pane falls back to the "Rebel is setting up" state.
 *
 * Exposed via an internal reset-for-tests override; in production this is
 * always called from `sendTaskpaneHtml` at HTML-serve time.
 */
async function ensureBridgeAuth(
  sidecarStateDir: string | undefined,
): Promise<
  | {
      bridgeOrigin: string;
      bridgeAppToken: string;
      bridgeClientId: string;
    }
  | null
> {
  const bridge = readAppBridgeState(sidecarStateDir);
  if (!bridge) return null;

  // Fast path — cache still valid for this bridge instance.
  if (
    cachedMintedToken &&
    cachedMintedToken.bridgePort === bridge.port &&
    cachedMintedToken.bridgeStartedAt === bridge.startedAt
  ) {
    return {
      bridgeOrigin: bridge.bridgeOrigin,
      bridgeAppToken: cachedMintedToken.bridgeAppToken,
      bridgeClientId: cachedMintedToken.bridgeClientId,
    };
  }

  const clientId = resolveOfficeClientId(sidecarStateDir);
  const token = await requestMintedAppToken(bridge, clientId);
  if (!token) {
    // Invalidate any stale cache so we don't keep serving a revoked token.
    cachedMintedToken = null;
    return null;
  }

  cachedMintedToken = {
    bridgePort: bridge.port,
    bridgeStartedAt: bridge.startedAt,
    bridgeAppToken: token,
    bridgeClientId: clientId,
  };

  return {
    bridgeOrigin: bridge.bridgeOrigin,
    bridgeAppToken: token,
    bridgeClientId: clientId,
  };
}

/** Test-only: drop the mint cache so the next request re-mints. */
export function __resetBridgeAuthCacheForTests(): void {
  cachedMintedToken = null;
}

/**
 * Serve taskpane.html with the sidecar config injected as a script tag.
 * The config allows the add-in to discover the WebSocket port and token,
 * plus (best-effort) the App Bridge origin + a freshly-minted paired
 * token for the embedded chat.
 */
async function sendTaskpaneHtml(
  res: http.ServerResponse,
  htmlPath: string,
  port: number,
  token: string,
  sidecarStateDir: string | undefined,
): Promise<void> {
  try {
    let html = fs.readFileSync(htmlPath, 'utf8');

    // Assemble the injected config. `bridgeReady` is the only bridge-facing
    // field the task-pane needs: the chat UI uses it as a pre-flight gate
    // (`true` → show the composer; `false` → show the "Rebel is setting up"
    // prompt without attempting to send). The paired app token NEVER
    // crosses into the task-pane any more — all `/intent/*` calls route
    // through the sidecar's own proxy which holds the token server-side.
    // This keeps the surface attacker-reachable from inside the WebView
    // narrow: only the sidecar Bearer token.
    //
    // When `ensureBridgeAuth` fails (bridge not running, mint round-trip
    // times out) we inject `bridgeReady: false`; the sidecar proxy routes
    // will independently re-check and can still succeed on a subsequent
    // request if the bridge comes up mid-session.
    const bridgeAuth = await ensureBridgeAuth(sidecarStateDir);
    const injectedConfig: Record<string, unknown> = {
      port,
      token,
      bridgeReady: bridgeAuth !== null,
    };

    const configScript = `<script>window.__REBEL_SIDECAR_CONFIG=${JSON.stringify(injectedConfig)};</script>`;
    html = html.replace('</head>', `${configScript}\n</head>`);

    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
      // Defense-in-depth: even though the route is on https://127.0.0.1:<port> with
      // browser default-deny CORS, set explicit headers so the auth token embedded
      // in the page can't be exfiltrated via a permissive CORS regression or sniffing.
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

async function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw createInvalidRequestError('Request body must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) {
    return null;
  }

  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token.length > 0 ? token : null;
}

/**
 * DNS-rebinding guard. The sidecar binds to 127.0.0.1 and serves a taskpane
 * page that embeds the API token, so a browser tricked into hitting
 * https://attacker.example/<port>/taskpane.html via DNS rebinding could
 * otherwise steal the token. Office's manifest only ever uses `localhost:<port>`
 * (see manifest.ts) and curl-style smoke checks use `127.0.0.1:<port>`.
 * Anything else is hostile.
 */
function isLoopbackHost(req: http.IncomingMessage, boundPort: number): boolean {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) {
    return false;
  }

  // Strip optional bracketed IPv6 form, then split host:port from the right.
  const lastColon = hostHeader.lastIndexOf(':');
  if (lastColon < 0) {
    return false;
  }
  const rawHost = hostHeader.slice(0, lastColon).replace(/^\[|\]$/g, '').toLowerCase();
  const rawPort = hostHeader.slice(lastColon + 1);
  if (rawPort !== String(boundPort)) {
    return false;
  }

  return rawHost === '127.0.0.1' || rawHost === 'localhost' || rawHost === '::1';
}

function parseCommandPath(pathname: string): { app: OfficeApp; action: string } | null {
  const [appRaw, actionRaw, ...rest] = pathname.split('/').filter(Boolean);
  if (rest.length > 0 || !appRaw || !actionRaw) {
    return null;
  }

  if (!isOfficeApp(appRaw)) {
    return null;
  }

  const action = decodeURIComponent(actionRaw);
  if (!action || action.trim().length === 0) {
    return null;
  }

  return {
    app: appRaw,
    action,
  };
}

function parseWsMessage(data: RawData): AddinToSidecarMessage | null {
  try {
    const raw = JSON.parse(data.toString()) as { type?: unknown };
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') {
      return null;
    }
    return raw as AddinToSidecarMessage;
  } catch {
    return null;
  }
}

export async function startOfficeSidecar(options: StartSidecarOptions = {}): Promise<OfficeSidecar> {
  const token = generateToken();
  const host = options.host ?? DEFAULT_HOST;
  const stateDir = options.stateDirectory ?? process.env['MCP_OFFICE_SIDECAR_STATE_DIR'];
  const diagTail = createDiagTailBuffer(DIAG_TAIL_CAPACITY);
  const recordDiagLine = (line: string): void => {
    if (line.startsWith('[sidecar-diag]') || line.startsWith('[sidecar-proxy]')) {
      diagTail.record(line);
    }
  };
  const emitDiagLine = (line: string): void => {
    recordDiagLine(line);
    console.error(line);
  };

  // --- Resolve add-in static files directory ---
  const addinDir = options.addinDir ?? undefined;

  const connectionManager = new ConnectionManager<OfficeAppId>({
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
    // Office's original default was 3 missed pongs (≈45 s). Preserve that
    // rather than fall through to core's 2-miss default (R21 goal: zero
    // user-visible behavior change).
    maxMissedPongs: options.maxMissedPongs ?? 3,
  });
  const commandRouter = new CommandRouter<OfficeAppId>(connectionManager, {
    timeoutMs: options.commandTimeoutMs ?? 30_000,
  });
  connectionManager.on('disconnect', (appId: OfficeAppId) => {
    commandRouter.rejectPendingForApp(appId);
  });

  // Mutable port — set after server starts listening, used by request handler.
  let boundPort = 0;

  // Office requires HTTPS for SourceLocation URLs, even for localhost.
  // Use Microsoft's office-addin-dev-certs package which generates a trusted
  // localhost certificate and installs the CA into the system keychain.
  const httpsOptions = await getHttpsServerOptions();
  const server = https.createServer(httpsOptions);

  server.on('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // --- Per-request diag instrumentation (260424 — Word taskpane cannot reach bridge) ---
    // Goal: prove whether the taskpane's fetches arrive at this sidecar, and if so,
    // whether they pass the bearer check. Emits to stderr so the Electron main process
    // captures them via `office-sidecar.child-stderr` → main log.
    const diagId = Math.random().toString(36).slice(2, 10);
    const diagStart = Date.now();
    const diagMethod = req.method ?? 'GET';
    const diagPath = (req.url ?? '/').split('?')[0] ?? '/';
    const diagOrigin = String(req.headers['origin'] ?? '-');
    const diagUserAgent = String(req.headers['user-agent'] ?? '-').slice(0, 60);
    const diagAuthHeader = req.headers['authorization'];
    const diagHasAuth = typeof diagAuthHeader === 'string' && diagAuthHeader.length > 0;
    const diagBearer = diagHasAuth && diagAuthHeader.startsWith('Bearer ')
      ? diagAuthHeader.slice('Bearer '.length)
      : null;
    const diagBearerLen = diagBearer?.length ?? 0;
    const diagBearerPrefix = diagBearer ? diagBearer.slice(0, 4) : '-';
    const diagBearerOk = diagBearer ? constantTimeStringEqual(diagBearer, token) : false;
    const requestId = readRequestCorrelationId(req.headers[REQUEST_ID_HEADER_NAME]);
    emitDiagLine(
      `[sidecar-diag] req id=${diagId} requestId=${requestId} ${diagMethod} ${diagPath} origin=${diagOrigin} hasAuth=${diagHasAuth} bearerLen=${diagBearerLen} bearerPrefix=${diagBearerPrefix} bearerOk=${diagBearerOk} expectedTokenLen=${token.length} expectedPrefix=${token.slice(0, 4)} ua=${diagUserAgent}`,
    );
    // Wrap res.end so we log final status + duration regardless of which branch handled it.
    const origEnd = res.end.bind(res) as typeof res.end;
    let endLogged = false;
    (res as http.ServerResponse).end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      if (!endLogged) {
        endLogged = true;
        const dur = Date.now() - diagStart;
        emitDiagLine(
          `[sidecar-diag] res id=${diagId} requestId=${requestId} status=${res.statusCode} dur=${dur}ms path=${diagPath}`,
        );
      }
      return (origEnd as (c?: unknown, e?: unknown, cb?: unknown) => http.ServerResponse).call(
        res,
        chunk,
        encoding,
        cb,
      );
    }) as typeof res.end;

    try {
      const method = req.method ?? 'GET';
      const requestUrl = new URL(req.url ?? '/', `https://${host}`);

      // ----- Unauthenticated static routes -----

      // Lightweight diagnostic probe — no auth. Lets humans curl the sidecar
      // to confirm reachability, and lets the taskpane smoke-test before the
      // first real fetch. Never returns secrets, only shape + prefixes.
      if (method === 'GET' && requestUrl.pathname === '/diag/ping') {
        const body = JSON.stringify({
          ok: true,
          pid: process.pid,
          port: boundPort,
          tokenPrefix: token.slice(0, 4),
          tokenLen: token.length,
          uptimeMs: Date.now() - diagStart + (Date.now() - diagStart), // rough
          now: new Date().toISOString(),
        });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }

      if (method === 'GET' && requestUrl.pathname === '/diag/tail') {
        const body = JSON.stringify({
          lines: diagTail.dump(),
          capturedAt: new Date().toISOString(),
        });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }

      // Diagnostic logging sink for the taskpane — no auth (we want client-side
      // errors to surface even when the bearer is wrong). Logs to stderr so the
      // Electron main process picks it up via `office-sidecar.child-stderr`.
      if (method === 'POST' && requestUrl.pathname === '/diag/log') {
        try {
          const body = await parseJsonBody(req);
          const line = JSON.stringify(body).slice(0, 2000);
          console.error(`[taskpane-diag] ${line}`);
        } catch (err) {
          console.error(`[taskpane-diag] parse-failed err=${String(err).slice(0, 200)}`);
        }
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }

      if (method === 'GET' && requestUrl.pathname === '/health') {
        // Core's ConnectionManager tracks connections by `OfficeAppId`
        // (`'office-word'` etc.) but Office's HTTP wire format uses the bare
        // `OfficeApp` keys. Translate at the surface.
        const connectedIds = new Set(connectionManager.getConnectedAppIds());
        sendJson(res, 200, {
          status: 'ok',
          connected: {
            word: connectedIds.has(toOfficeAppId('word')),
            excel: connectedIds.has(toOfficeAppId('excel')),
            powerpoint: connectedIds.has(toOfficeAppId('powerpoint')),
          },
        });
        return;
      }

      if (method === 'GET' && requestUrl.pathname === '/taskpane.html') {
        if (!isLoopbackHost(req, boundPort)) {
          throw createUnauthorizedError();
        }
        if (addinDir) {
          await sendTaskpaneHtml(
            res,
            path.join(addinDir, 'taskpane.html'),
            boundPort,
            token,
            stateDir,
          );
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Add-in not built. Run: npm run build:addin');
        }
        return;
      }

      if (method === 'GET' && requestUrl.pathname === '/taskpane.js') {
        if (!isLoopbackHost(req, boundPort)) {
          throw createUnauthorizedError();
        }
        if (addinDir) {
          sendFile(res, path.join(addinDir, 'taskpane.js'), CONTENT_TYPES['.js']!);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Add-in not built. Run: npm run build:addin');
        }
        return;
      }

      if (method === 'GET' && requestUrl.pathname.startsWith('/assets/')) {
        if (!isLoopbackHost(req, boundPort)) {
          throw createUnauthorizedError();
        }
        if (addinDir) {
          const safeName = path.basename(requestUrl.pathname);
          const ext = path.extname(safeName);
          const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
          sendFile(res, path.join(addinDir, 'assets', safeName), contentType);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
        return;
      }

      // ----- Authenticated API routes -----

      const bearerToken = extractBearerToken(req);
      if (!bearerToken || !constantTimeStringEqual(bearerToken, token)) {
        emitDiagLine(
          `[sidecar-diag] AUTH-FAIL id=${diagId} requestId=${requestId} path=${requestUrl.pathname} gotLen=${
            bearerToken?.length ?? 0
          } gotPrefix=${bearerToken?.slice(0, 4) ?? '-'} expectedLen=${
            token.length
          } expectedPrefix=${token.slice(0, 4)} hasAuthHeader=${
            req.headers.authorization ? 'yes' : 'no'
          }`,
        );
        throw createUnauthorizedError();
      }

      // ----- App Bridge `/intent/*` proxy -----
      //
      // Must come BEFORE the `/{app}/{action}` command-route parser
      // (which rejects non-POST). The proxy handles GET (history /
      // stream) and POST (create / message / focus) itself, server-to-
      // server to the bridge, so the Office task-pane can talk to
      // `/intent/*` over same-origin HTTPS without hitting the bridge's
      // extension-only CORS allowlist.
      //
      // Any path under `/intent/` is claimed by the proxy — including
      // ones outside the explicit allowlist, which the proxy renders as
      // a 404 NOT_FOUND. That way an unknown `/intent/foo` does not
      // accidentally fall through to the command-route parser and
      // surface as the generic 400 "only POST" error.
      if (requestUrl.pathname.startsWith('/intent/')) {
        await handleIntentProxy(
          req,
          res,
          {
            ensureBridgeAuth: () => ensureBridgeAuth(stateDir),
            recordDiagLine,
            invalidateCachedMintedToken,
            ...(options.intentProxyStreamReadTimeoutMs !== undefined
              ? { streamReadTimeoutMs: options.intentProxyStreamReadTimeoutMs }
              : {}),
          },
          requestUrl.pathname,
        );
        return;
      }

      if (method === 'GET' && requestUrl.pathname === '/sidecar/identify') {
        res.writeHead(204, {
          'X-Rebel-Sidecar-Pid': String(process.pid),
        });
        res.end();
        return;
      }

      if (method !== 'POST') {
        throw createInvalidRequestError('Only POST requests are supported for command routes.');
      }

      const route = parseCommandPath(requestUrl.pathname);
      if (!route) {
        throw createInvalidRequestError('Command route must be /{app}/{action}.');
      }

      const params = await parseJsonBody(req);
      const appId = toOfficeAppId(route.app);
      let result: CommandResult;
      try {
        result = await commandRouter.routeCommand(appId, route.action, params);
      } catch (err) {
        // Core's CommandRouter throws/rejects with `AppBridgeError` plain
        // objects. Translate to Office's `SidecarHttpError` so the outer
        // catch can render it with Office's brand-voice messages. Any other
        // throw falls through to the generic 500 handler below.
        if (isAppBridgeError(err)) {
          throw fromAppBridgeError(err, route.app);
        }
        throw err;
      }
      sendJson(res, 200, stripCommandId(result));
    } catch (error) {
      if (error instanceof SidecarHttpError) {
        sendJson(res, error.status, buildErrorResponse(error));
        return;
      }

      if (error instanceof SyntaxError) {
        const badJsonError = createInvalidRequestError('Invalid JSON request body.');
        sendJson(res, badJsonError.status, buildErrorResponse(badJsonError));
        return;
      }

      console.error(
        `[office-sidecar] HTTPS handler failed id=${diagId} requestId=${requestId} path=${diagPath} errName=${
          (error as { name?: string })?.name ?? '-'
        } errMsg=${String((error as Error)?.message ?? error).slice(0, 300)}`,
      );
      const internalError = createInternalError();
      sendJson(res, internalError.status, buildErrorResponse(internalError));
    }
  });

  const webSocketServer = new WebSocketServer({ noServer: true });
  const socketStates = new WeakMap<WebSocket, SocketAuthState>();

  webSocketServer.on('connection', (socket) => {
    const authTimer = setTimeout(() => {
      const state = socketStates.get(socket);
      if (!state?.authenticated) {
        socket.close(4001, 'Unauthorized');
      }
    }, 5_000);

    socketStates.set(socket, { authenticated: false, authTimer });

    socket.on('message', (data) => {
      const message = parseWsMessage(data);
      if (!message) {
        socket.close(4002, 'Invalid message');
        return;
      }

      const socketState = socketStates.get(socket);
      if (!socketState) {
        socket.close(1011, 'Server state missing');
        return;
      }

      if (!socketState.authenticated) {
        const authMessage = message as Partial<AuthMessage>;
        if (authMessage.type !== 'auth' || !constantTimeStringEqual(String(authMessage.token ?? ''), token)) {
          socket.close(4001, 'Unauthorized');
          return;
        }

        socketState.authenticated = true;
        clearTimeout(socketState.authTimer);
        return;
      }

      switch (message.type) {
        case 'register': {
          // Accept both the legacy `{ type, app, version }` shape the shipped
          // Office add-in sends (R26) and the upgraded core-shaped
          // `{ type, appId, ... }` message. `validateRegisterMessage`
          // returns `null` on malformed payloads.
          const normalised = validateRegisterMessage(message);
          if (!normalised) {
            socket.close(4002, 'Invalid register message');
            return;
          }
          connectionManager.register({
            socket,
            appId: normalised.appId,
            clientId: normalised.clientId ?? '',
            protocolVersion: normalised.protocolVersion ?? '1.0',
            capabilities: normalised.capabilities ?? [],
            ...(normalised.appVersion !== undefined
              ? { version: normalised.appVersion }
              : {}),
          });
          return;
        }

        case 'response':
          if (typeof message.id !== 'string' || message.id.trim().length === 0 || typeof message.success !== 'boolean') {
            socket.close(4002, 'Invalid response message');
            return;
          }
          commandRouter.handleResponse(message as ResponseMessage);
          return;

        case 'ping':
          socket.send(JSON.stringify({ type: 'pong' }));
          return;

        case 'pong':
          connectionManager.markPong(socket);
          return;

        case 'auth':
          socket.close(4002, 'Auth already complete');
          return;

        default:
          socket.close(4002, 'Unknown message type');
      }
    });

    socket.on('close', () => {
      const state = socketStates.get(socket);
      if (state) {
        clearTimeout(state.authTimer);
      }
      connectionManager.unregister(socket);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const requestUrl = new URL(req.url ?? '/', `https://${host}`);
      if (requestUrl.pathname !== WS_PATH) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
    } catch {
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      webSocketServer.emit('connection', ws, req);
    });
  });

  // Resolve the list of ports to try. An explicit `port` wins (useful for tests).
  // Otherwise use the preferred list — the first one is our canonical fixed port,
  // the rest are fallbacks for the rare case it's briefly in use.
  const portsToTry: readonly number[] =
    typeof options.port === 'number'
      ? [options.port]
      : options.portCandidates && options.portCandidates.length > 0
        ? options.portCandidates
        : SIDECAR_PORT_FALLBACKS;

  const tryBind = (candidate: number): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to resolve bound sidecar port.'));
          return;
        }
        resolve(address.port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, host);
    });

  let port = -1;
  const bindErrors: string[] = [];
  for (const candidate of portsToTry) {
    try {
      port = await tryBind(candidate);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' || code === 'EACCES') {
        bindErrors.push(`port ${candidate}: ${code}`);
        continue;
      }
      throw err;
    }
  }

  if (port < 0) {
    throw new Error(
      `Office sidecar could not bind to any port (tried: ${portsToTry.join(', ')}). ` +
        `Details: ${bindErrors.join('; ')}. ` +
        `This usually means another process is holding these ports — restart your machine or ` +
        `find and stop the conflicting process with 'lsof -i :${portsToTry[0]}'.`,
    );
  }

  // Set the mutable port so the request handler can inject it into taskpane.html
  boundPort = port;

  // --- Write manifest to state directory ---
  let manifestPath: string | undefined;
  let wefInstallResults: WefInstallResult[] | undefined;
  if (stateDir) {
    manifestPath = await writeManifest(port, stateDir);

    // --- Auto-install manifests into Office WEF folders ---
    // Idempotent: only writes if missing or content changed. This removes the
    // need for users to run `rebel_office_setup` as a first-time setup step —
    // the first tool call spawns the sidecar, which writes the manifests directly
    // into the wef folders Office reads at launch.
    const shouldInstall = options.installToWefFolders ?? true;
    if (shouldInstall) {
      try {
        wefInstallResults = await installManifestsToWefFolders(stateDir);
        const failed = wefInstallResults.filter((r) => r.status === 'failed');
        if (failed.length > 0) {
          // Don't throw — partial install is still useful (e.g., only Word failed).
          // Log clearly so the problem is visible in logs.
          console.error(
            `[office-sidecar] Some WEF manifest installs failed: ${failed
              .map((r) => `${r.app}=${r.error ?? 'unknown'}`)
              .join('; ')}`,
          );
        }
      } catch (err) {
        // Unexpected error during install — log but don't crash the sidecar,
        // since the add-in may already be installed from a previous run.
        console.error('[office-sidecar] Failed to install manifests to WEF folders:', err);
      }
    }
  }

  // --- Write state file ---
  let stateFilePath: string;
  try {
    stateFilePath = await writeStateFile(
      {
        port,
        token,
        pid: process.pid,
        manifestPath,
      },
      stateDir,
    );
  } catch (error) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    throw error;
  }

  connectionManager.startHeartbeat();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;

    connectionManager.stopHeartbeat();
    commandRouter.dispose();
    webSocketServer.close();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Clean up state file so the MCP server doesn't connect to a dead sidecar
    try {
      await import('node:fs/promises').then(fsp => fsp.unlink(stateFilePath));
    } catch {
      // Best effort — file may already be gone
    }
  };

  return {
    port,
    token,
    pid: process.pid,
    stateFilePath,
    manifestPath,
    wefInstallResults,
    stop,
  };
}

// NOTE: Previously this module had a self-running entry-point block
// (`if (import.meta.url === pathToFileURL(process.argv[1]).href) runFromCli()`)
// so `index.ts` could be executed directly as a fallback CLI. That is now
// a bug: esbuild bundles `index.ts` into `dist/sidecar/cli.js` alongside
// `cli.ts`, which caused the condition to match inside the bundled `cli.js`
// and trigger TWO sidecar startups in the same process — one without
// `addinDir` (binding to the primary port and serving "Add-in not built"
// for `/taskpane.html`) and one with `addinDir` on the fallback port that
// Word never hits because the manifest points to the primary port.
// `cli.ts` is the sole CLI entry point; do not add another here.
