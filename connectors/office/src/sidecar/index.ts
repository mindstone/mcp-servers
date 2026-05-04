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
 * Serve taskpane.html with the sidecar config injected as a script tag.
 * The config allows the add-in to discover the WebSocket port and token.
 */
function sendTaskpaneHtml(
  res: http.ServerResponse,
  htmlPath: string,
  port: number,
  token: string,
): void {
  try {
    let html = fs.readFileSync(htmlPath, 'utf8');

    // Inject sidecar config before the closing </head> tag
    const configScript = `<script>window.__REBEL_SIDECAR_CONFIG=${JSON.stringify({ port, token })};</script>`;
    html = html.replace('</head>', `${configScript}\n</head>`);

    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
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
    try {
      const method = req.method ?? 'GET';
      const requestUrl = new URL(req.url ?? '/', `https://${host}`);

      // ----- Unauthenticated static routes -----

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
        if (addinDir) {
          sendTaskpaneHtml(res, path.join(addinDir, 'taskpane.html'), boundPort, token);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Add-in not built. Run: npm run build:addin');
        }
        return;
      }

      if (method === 'GET' && requestUrl.pathname === '/taskpane.js') {
        if (addinDir) {
          sendFile(res, path.join(addinDir, 'taskpane.js'), CONTENT_TYPES['.js']!);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Add-in not built. Run: npm run build:addin');
        }
        return;
      }

      if (method === 'GET' && requestUrl.pathname.startsWith('/assets/')) {
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
        throw createUnauthorizedError();
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

      console.error('[office-sidecar] HTTPS handler failed', error);
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
