import * as fs from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as realDelay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { atomicWriteFile, resolveStateFilePath } from '../src/sidecar/auth.js';
import * as constantTimeModule from '../src/shared/sidecar/constantTime.js';
import { CommandRouter } from '../src/shared/appBridge/server/commandRouter.js';
import { startOfficeSidecar, type OfficeSidecar } from '../src/sidecar/index.js';

// ---------------------------------------------------------------------------
// HTTPS helpers for testing (sidecar uses office-addin-dev-certs)
// ---------------------------------------------------------------------------

async function fetchHttps(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string>; headers: Record<string, string | string[] | undefined> }> {
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: options.method ?? 'GET',
        headers: options.headers,
        rejectUnauthorized: false,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: () => Promise.resolve(body.length > 0 ? JSON.parse(body) as unknown : null),
            text: () => Promise.resolve(body),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

type TestServer = {
  sidecar: OfficeSidecar;
  stateDir: string;
  baseUrl: string;
};

const cleanupServers: OfficeSidecar[] = [];
const cleanupDirs: string[] = [];

async function startTestServer(options: Parameters<typeof startOfficeSidecar>[0] = {}): Promise<TestServer> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sidecar-test-'));
  cleanupDirs.push(stateDir);

  const sidecar = await startOfficeSidecar({
    stateDirectory: stateDir,
    // Use a random OS-assigned port so tests don't collide with the fixed
    // production port (DEFAULT_SIDECAR_PORT) or with each other when run in parallel.
    port: 0,
    // Never touch real Office wef folders from tests.
    installToWefFolders: false,
    ...options,
  });

  cleanupServers.push(sidecar);

  return {
    sidecar,
    stateDir,
    baseUrl: `https://127.0.0.1:${sidecar.port}`,
  };
}

async function connectWebSocket(port: number): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function waitForConnection(baseUrl: string, app: 'word' | 'excel' | 'powerpoint'): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetchHttps(`${baseUrl}/health`);
    const payload = await response.json() as { connected: Record<string, boolean> };
    if (payload.connected?.[app] === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${app} registration`);
}

function sendSocketMessage(socket: WebSocket, payload: unknown): void {
  socket.send(JSON.stringify(payload));
}

afterEach(async () => {
  vi.useRealTimers();

  while (cleanupServers.length > 0) {
    const server = cleanupServers.pop();
    if (server) {
      await server.stop();
    }
  }

  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('office sidecar', () => {
  it('starts on a dynamic port and writes state file', async () => {
    const { sidecar, stateDir } = await startTestServer();
    expect(sidecar.port).toBeGreaterThan(0);

    const stateFilePath = resolveStateFilePath(stateDir);
    const state = JSON.parse(await fs.readFile(stateFilePath, 'utf8')) as {
      port: number;
      token: string;
      pid: number;
    };

    expect(state.port).toBe(sidecar.port);
    expect(state.token).toBe(sidecar.token);
    expect(state.pid).toBe(process.pid);
  });

  it('health check returns connected status', async () => {
    const { baseUrl } = await startTestServer();
    const response = await fetchHttps(`${baseUrl}/health`);
    const payload = await response.json() as {
      status: string;
      connected: { word: boolean; excel: boolean; powerpoint: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      status: 'ok',
      connected: {
        word: false,
        excel: false,
        powerpoint: false,
      },
    });
  });

  it('rejects /taskpane.html requests whose Host header is not a loopback host (DNS-rebinding guard)', async () => {
    const { baseUrl, sidecar } = await startTestServer();
    const response = await fetchHttps(`${baseUrl}/taskpane.html`, {
      headers: { Host: `attacker.example:${sidecar.port}` },
    });
    expect(response.status).toBe(401);
  });

  it('accepts /taskpane.html when Host header is localhost on the bound port', async () => {
    const { baseUrl, sidecar } = await startTestServer();
    // No addinDir was passed to startTestServer, so a successful guard pass
    // falls through to the "Add-in not built" 404 path. Either way, NOT 401.
    const response = await fetchHttps(`${baseUrl}/taskpane.html`, {
      headers: { Host: `localhost:${sidecar.port}` },
    });
    expect(response.status).not.toBe(401);
  });

  it('accepts auth then register from a Word websocket client', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    sendSocketMessage(socket, { type: 'auth', token: sidecar.token });
    sendSocketMessage(socket, { type: 'register', app: 'word', version: '1.0.0' });

    await waitForConnection(baseUrl, 'word');
    socket.close();
  });

  it('routes HTTP commands to connected websocket clients and returns responses', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    sendSocketMessage(socket, { type: 'auth', token: sidecar.token });
    sendSocketMessage(socket, { type: 'register', app: 'word', version: '1.0.0' });
    await waitForConnection(baseUrl, 'word');

    const commandSeen = new Promise<{ action: string; params: Record<string, unknown> }>((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          id?: string;
          action?: string;
          params?: Record<string, unknown>;
        };
        if (message.type === 'command' && typeof message.id === 'string') {
          sendSocketMessage(socket, {
            type: 'response',
            id: message.id,
            success: true,
            data: { text: 'mock document' },
          });
          resolve({
            action: message.action ?? '',
            params: message.params ?? {},
          });
        }
      });
    });

    const response = await fetchHttps(`${baseUrl}/word/read_document`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sidecar.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ maxParagraphs: 10 }),
    });

    const payload = await response.json() as { success: boolean; data: { text: string } };
    const routed = await commandSeen;

    expect(routed).toEqual({
      action: 'read_document',
      params: { maxParagraphs: 10 },
    });
    expect(response.status).toBe(200);
    expect(payload).toEqual({
      success: true,
      data: { text: 'mock document' },
    });

    socket.close();
  });

  it('returns a timeout error after 30 seconds', async () => {
    vi.useFakeTimers();
    const mockSocket = {
      readyState: WebSocket.OPEN,
      send: (_data: unknown, callback?: (error?: Error) => void) => {
        callback?.();
      },
    } as unknown as WebSocket;

    const connectionManager = {
      getConnection: () => ({
        app: 'word' as const,
        version: '1.0.0',
        socket: mockSocket,
        missedPongs: 0,
      }),
    } as ConstructorParameters<typeof CommandRouter>[0];

    // Stage 8 — core's CommandRouter takes an options object. Office passed
    // the timeout positionally before; the new shape is `{ timeoutMs }`.
    const router = new CommandRouter(connectionManager, { timeoutMs: 30_000 });
    const pending = router.routeCommand('word', 'read_document', {});
    const pendingExpectation = expect(pending).rejects.toMatchObject({
      code: 'COMMAND_TIMEOUT',
      status: 504,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await pendingExpectation;
    router.dispose();
  });

  it('rejects pending requests when websocket disconnects mid-command', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    sendSocketMessage(socket, { type: 'auth', token: sidecar.token });
    sendSocketMessage(socket, { type: 'register', app: 'word', version: '1.0.0' });
    await waitForConnection(baseUrl, 'word');

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type?: string };
      if (message.type === 'command') {
        socket.close();
      }
    });

    const response = await fetchHttps(`${baseUrl}/word/insert_text`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sidecar.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'hello' }),
    });
    const payload = await response.json() as { success: false; code: string };

    expect(response.status).toBe(503);
    expect(payload.code).toBe('ADDIN_DISCONNECTED');
  });

  it('rejects unauthenticated websocket connections', async () => {
    const { sidecar } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    const closed = new Promise<number>((resolve, reject) => {
      socket.once('close', (code) => resolve(code));
      socket.once('error', reject);
    });

    sendSocketMessage(socket, { type: 'register', app: 'word', version: '1.0.0' });
    const closeCode = await closed;
    expect(closeCode).toBe(4001);
  });

  it('uses constant-time comparison for websocket auth', async () => {
    const constantTimeSpy = vi.spyOn(constantTimeModule, 'constantTimeStringEqual');
    const { sidecar } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    sendSocketMessage(socket, { type: 'auth', token: sidecar.token });

    // The server-side auth handler runs on the websocket's `message` event,
    // which is scheduled across the network round-trip — a single
    // setTimeout(0) flush is not enough on a loaded CI runner and the
    // assertion races the spy. Poll until the spy has been called (or fail
    // with a useful error after vitest's default waitFor budget).
    await vi.waitFor(() => {
      expect(constantTimeSpy).toHaveBeenCalledWith(sidecar.token, sidecar.token);
    });

    socket.close();
  });

  it('returns 401 for unauthenticated HTTP requests', async () => {
    const { baseUrl } = await startTestServer();
    const response = await fetchHttps(`${baseUrl}/word/read_document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const payload = await response.json() as { success: false; code: string };

    expect(response.status).toBe(401);
    expect(payload.code).toBe('UNAUTHORIZED');
  });

  it('serves /diag/ping, /diag/log, and /diag/tail without auth for Word debugging', async () => {
    const { baseUrl } = await startTestServer();

    const ping = await fetchHttps(`${baseUrl}/diag/ping`);
    const pingPayload = (await ping.json()) as {
      ok: boolean;
      port: number;
      tokenPrefix: string;
      tokenLen: number;
    };
    expect(ping.status).toBe(200);
    expect(pingPayload.ok).toBe(true);
    expect(pingPayload.port).toBeGreaterThan(0);
    expect(pingPayload.tokenPrefix.length).toBeGreaterThan(0);
    expect(pingPayload.tokenLen).toBeGreaterThan(0);

    const diagLog = await fetchHttps(`${baseUrl}/diag/log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rebel-Diag-Id': 'req-stage-11',
      },
      body: JSON.stringify({
        event: 'fetch.start',
        data: { requestId: 'req-stage-11' },
      }),
    });
    expect(diagLog.status).toBe(204);
    await expect(diagLog.text()).resolves.toBe('');

    const tail = await fetchHttps(`${baseUrl}/diag/tail`);
    const tailPayload = (await tail.json()) as { lines: string[]; capturedAt: string };
    expect(tail.status).toBe(200);
    expect(tailPayload.capturedAt.length).toBeGreaterThan(0);
    expect(
      tailPayload.lines.every(
        (line) =>
          line.startsWith('[sidecar-diag]') || line.startsWith('[sidecar-proxy]'),
      ),
    ).toBe(true);
    expect(
      tailPayload.lines.some((line) => line.includes('GET /diag/ping')),
    ).toBe(true);
    expect(
      tailPayload.lines.some((line) => line.includes('path=/diag/log')),
    ).toBe(true);
    expect(
      tailPayload.lines.some((line) => line.includes('requestId=req-stage-11')),
    ).toBe(true);
  });

  // TODO(F8): un-skip when upstream gap is closed. See plan doc Stage J F8.
  it.skip('feeds /diag/log body into /diag/tail (F8 — re-enable after upstream fix)', async () => {
    const { baseUrl } = await startTestServer();
    const payload = {
      event: 'taskpane.fetch.start',
      data: { requestId: 'req-f8-contract', op: 'sendMessage' },
    };

    const diagLog = await fetchHttps(`${baseUrl}/diag/log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rebel-Diag-Id': 'req-f8-contract',
      },
      body: JSON.stringify(payload),
    });
    expect(diagLog.status).toBe(204);

    const tail = await fetchHttps(`${baseUrl}/diag/tail`);
    const tailPayload = (await tail.json()) as { lines: string[]; capturedAt: string };
    expect(tail.status).toBe(200);
    expect(tailPayload.lines.some((line) => line.includes(payload.event))).toBe(true);
    expect(tailPayload.lines.some((line) => line.includes('req-f8-contract'))).toBe(true);
  });

  it('returns 204 from /sidecar/identify for the correct bearer token', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const response = await fetchHttps(`${baseUrl}/sidecar/identify`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sidecar.token}`,
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers['x-rebel-sidecar-pid']).toBe(String(process.pid));
    await expect(response.text()).resolves.toBe('');
  });

  it('returns 401 from /sidecar/identify for the wrong bearer token', async () => {
    const { baseUrl } = await startTestServer();
    const response = await fetchHttps(`${baseUrl}/sidecar/identify`, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer wrong-token',
      },
    });
    const payload = await response.json() as { success: false; code: string };

    expect(response.status).toBe(401);
    expect(payload.code).toBe('UNAUTHORIZED');
  });

  it('returns APP_NOT_CONNECTED for commands to unconnected apps', async () => {
    const { sidecar, baseUrl } = await startTestServer({ commandTimeoutMs: 30 });
    const response = await fetchHttps(`${baseUrl}/word/read_document`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sidecar.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const payload = await response.json() as {
      success: false;
      error: string;
      code: string;
      app: string;
    };

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      success: false,
      error: "Word isn't connected. Open a document in Microsoft Word with the Rebel add-in enabled, then try again.",
      code: 'APP_NOT_CONNECTED',
      app: 'word',
    });
  });

  it('accepts auth then register from an Excel websocket client', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    sendSocketMessage(socket, { type: 'auth', token: sidecar.token });
    sendSocketMessage(socket, { type: 'register', app: 'excel', version: '1.0.0' });

    await waitForConnection(baseUrl, 'excel');
    socket.close();
  });

  it('accepts auth then register from a PowerPoint websocket client', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    sendSocketMessage(socket, { type: 'auth', token: sidecar.token });
    sendSocketMessage(socket, { type: 'register', app: 'powerpoint', version: '1.0.0' });

    await waitForConnection(baseUrl, 'powerpoint');
    socket.close();
  });

  it('routes HTTP commands to connected Excel clients', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    sendSocketMessage(socket, { type: 'auth', token: sidecar.token });
    sendSocketMessage(socket, { type: 'register', app: 'excel', version: '1.0.0' });
    await waitForConnection(baseUrl, 'excel');

    const commandSeen = new Promise<{ action: string; params: Record<string, unknown> }>((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          type?: string; id?: string; action?: string; params?: Record<string, unknown>;
        };
        if (message.type === 'command' && typeof message.id === 'string') {
          sendSocketMessage(socket, {
            type: 'response', id: message.id, success: true,
            data: { values: [[1, 2]], totalRows: 1 },
          });
          resolve({ action: message.action ?? '', params: message.params ?? {} });
        }
      });
    });

    const response = await fetchHttps(`${baseUrl}/excel/read_range`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sidecar.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ range: 'A1:B5', worksheet: 'Sheet1' }),
    });

    const payload = await response.json() as { success: boolean; data: unknown };
    const routed = await commandSeen;

    expect(routed.action).toBe('read_range');
    expect(routed.params).toEqual({ range: 'A1:B5', worksheet: 'Sheet1' });
    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);

    socket.close();
  });

  it('routes HTTP commands to connected PowerPoint clients', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    sendSocketMessage(socket, { type: 'auth', token: sidecar.token });
    sendSocketMessage(socket, { type: 'register', app: 'powerpoint', version: '1.0.0' });
    await waitForConnection(baseUrl, 'powerpoint');

    const commandSeen = new Promise<{ action: string; params: Record<string, unknown> }>((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          type?: string; id?: string; action?: string; params?: Record<string, unknown>;
        };
        if (message.type === 'command' && typeof message.id === 'string') {
          sendSocketMessage(socket, {
            type: 'response', id: message.id, success: true,
            data: { slideCount: 3, slides: [] },
          });
          resolve({ action: message.action ?? '', params: message.params ?? {} });
        }
      });
    });

    const response = await fetchHttps(`${baseUrl}/powerpoint/get_slides`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sidecar.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: 20 }),
    });

    const payload = await response.json() as { success: boolean; data: unknown };
    const routed = await commandSeen;

    expect(routed.action).toBe('get_slides');
    expect(routed.params).toEqual({ limit: 20 });
    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);

    socket.close();
  });

  it('returns APP_NOT_CONNECTED for Excel and PowerPoint when not connected', async () => {
    const { sidecar, baseUrl } = await startTestServer({ commandTimeoutMs: 30 });

    const excelRes = await fetchHttps(`${baseUrl}/excel/read_range`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const excelPayload = await excelRes.json() as { success: false; code: string; app: string; error: string };
    expect(excelRes.status).toBe(503);
    expect(excelPayload.code).toBe('APP_NOT_CONNECTED');
    expect(excelPayload.app).toBe('excel');
    expect(excelPayload.error).toContain("Excel isn't connected");

    const pptRes = await fetchHttps(`${baseUrl}/powerpoint/get_slides`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const pptPayload = await pptRes.json() as { success: false; code: string; app: string; error: string };
    expect(pptRes.status).toBe(503);
    expect(pptPayload.code).toBe('APP_NOT_CONNECTED');
    expect(pptPayload.app).toBe('powerpoint');
    expect(pptPayload.error).toContain("PowerPoint isn't connected");
  });

  it('writes the state file atomically', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sidecar-atomic-'));
    cleanupDirs.push(tempDir);

    const targetPath = path.join(tempDir, 'state.json');
    await atomicWriteFile(targetPath, JSON.stringify({ port: 1234, token: 'initial' }));
    await atomicWriteFile(targetPath, JSON.stringify({ port: 1234, token: 'updated' }));

    const written = JSON.parse(await fs.readFile(targetPath, 'utf8')) as { port: number; token: string };
    const files = await fs.readdir(tempDir);

    expect(files.filter((file) => file.includes('.tmp-'))).toEqual([]);
    expect(written).toEqual({ port: 1234, token: 'updated' });
  });

  it('falls back to next port when the preferred port is in use', async () => {
    // Grab a random OS-assigned port and hold it so the sidecar can't bind to it.
    const blocker = https.createServer();
    const blockerPort = await new Promise<number>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Blocker failed to bind'));
          return;
        }
        resolve(addr.port);
      });
    });

    try {
      // Ask the sidecar to try the blocked port first, then a free one.
      // The fallback candidate must also be free — use OS-assigned 0 as the last resort.
      const { sidecar } = await startTestServer({
        port: undefined,
        portCandidates: [blockerPort, 0],
      });

      expect(sidecar.port).not.toBe(blockerPort);
      expect(sidecar.port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('throws a clear error when all candidate ports are in use', async () => {
    const blocker = https.createServer();
    const blockerPort = await new Promise<number>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Blocker failed to bind'));
          return;
        }
        resolve(addr.port);
      });
    });

    try {
      await expect(
        startTestServer({
          port: undefined,
          portCandidates: [blockerPort],
        }),
      ).rejects.toThrow(/could not bind to any port/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});


describe('live command predispatch registration wait', () => {
  async function pendingRequest(commandTimeoutMs = 250) {
    const serverSpy = vi.spyOn(https, 'createServer');
    const { sidecar, baseUrl } = await startTestServer({ commandTimeoutMs });
    const server = serverSpy.mock.results.at(-1)!.value as https.Server;
    serverSpy.mockRestore();
    let incoming!: http.IncomingMessage;
    let outgoing!: http.ServerResponse;
    const seen = new Promise<void>((resolve) => server.once('request', (req, res) => {
      incoming = req; outgoing = res; req.once('end', resolve);
    }));
    let request!: http.ClientRequest;
    const result = new Promise<{ status: number; body: { code?: string; success?: boolean } }>((resolve, reject) => {
      request = https.request(`${baseUrl}/word/read_document`, {
        method: 'POST', rejectUnauthorized: false, agent: false,
        headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.once('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
      });
      request.once('error', reject);
      request.end('{}');
    });
    await seen;
    await realDelay(10);
    const assertClean = () => {
      for (const [emitter, event] of [[incoming, 'aborted'], [outgoing, 'close'], [incoming.socket, 'close']] as const) {
        expect(emitter.listeners(event).filter((listener) => listener.name === 'check')).toHaveLength(0);
      }
    };
    return { sidecar, baseUrl, request, result, incoming, outgoing, assertClean };
  }
  async function lateRegister(sidecar: OfficeSidecar) {
    const socket = await connectWebSocket(sidecar.port);
    const commands: unknown[] = [];
    const ack = new Promise<void>((resolve) => socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string };
      if (message.type === 'registered') resolve();
      if (message.type === 'command') commands.push(message);
    }));
    sendSocketMessage(socket, { type: 'auth', token: sidecar.token });
    sendSocketMessage(socket, { type: 'register', app: 'word', version: '1.0.0' });
    await ack;
    await realDelay(10);
    socket.close();
    return commands;
  }
  it('expires before registration, cleans up, and executes nothing on late registration', async () => {
    const fixture = await pendingRequest();
    expect(fixture.incoming.complete).toBe(true); // Body completion is not cancellation.
    expect(fixture.incoming.listeners('aborted').some((listener) => listener.name === 'check')).toBe(true);
    expect(await fixture.result).toMatchObject({ status: 503, body: { code: 'APP_NOT_CONNECTED' } });
    fixture.assertClean();
    expect(await lateRegister(fixture.sidecar)).toEqual([]);
    fixture.assertClean();
  });
  it('expires when the one-shot timer fires with wall time one millisecond behind', async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = await pendingRequest(250);
    try {
      for (const [emitter, event] of [[fixture.incoming, 'aborted'], [fixture.outgoing, 'close'], [fixture.incoming.socket, 'close']] as const) {
        expect(emitter.listeners(event).some((listener) => listener.name === 'check')).toBe(true);
      }
      clock.mockReturnValue(started + 249);
      await vi.advanceTimersByTimeAsync(250);
      const result = await Promise.race([
        fixture.result,
        realDelay(500).then(() => 'still-pending' as const),
      ]);
      expect(result).toMatchObject({ status: 503, body: { code: 'APP_NOT_CONNECTED' } });
      fixture.assertClean();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      expect(await lateRegister(fixture.sidecar)).toEqual([]);
      fixture.assertClean();
    } finally {
      fixture.request.destroy(new Error('Expiry-edge fixture cleanup'));
      await fixture.result.catch(() => undefined);
      clock.mockRestore();
      vi.useRealTimers();
    }
  });
  it('removes a disconnected caller before late registration without sending a command', async () => {
    const fixture = await pendingRequest();
    const rejected = expect(fixture.result).rejects.toThrow();
    fixture.request.destroy(new Error('Fictional caller disconnected'));
    await rejected;
    await realDelay(20);
    fixture.assertClean();
    expect(await lateRegister(fixture.sidecar)).toEqual([]);
  });
  it('settles a waiting request immediately on helper stop before closing the server', async () => {
    const fixture = await pendingRequest(30_000);
    const started = Date.now();
    const stopping = fixture.sidecar.stop();
    expect(await fixture.result).toMatchObject({ status: 503, body: { code: 'APP_NOT_CONNECTED' } });
    await stopping;
    expect(Date.now() - started).toBeLessThan(5_000);
    fixture.assertClean();
  });
  it('spends the original budget waiting and dispatches only once after the ack', async () => {
    const dispatch = vi.spyOn(CommandRouter.prototype, 'dispatch');
    const fixture = await pendingRequest(250);
    await realDelay(50);
    const socket = await connectWebSocket(fixture.sidecar.port);
    const events: string[] = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; id: string };
      events.push(message.type);
      // Deliberately no response: this sent command must remain uncertain.
    });
    sendSocketMessage(socket, { type: 'auth', token: fixture.sidecar.token });
    await realDelay(10);
    expect(dispatch).not.toHaveBeenCalled();
    sendSocketMessage(socket, { type: 'register', app: 'word', version: '1.0.0' });
    expect(await fixture.result).toMatchObject({ status: 504, body: { code: 'COMMAND_TIMEOUT' } });
    expect(events).toEqual(['registered', 'command']);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const budget = dispatch.mock.calls[0]![0].timeoutMs!;
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(200);
    fixture.assertClean();
    socket.close();
    dispatch.mockRestore();
  });
});

// Real production initialization/default chat IO against real helper HTTP/WS.
// Office command lookups and the upstream bridge are fictional fixtures. TLS
// bypass is limited to these fixture requests/sockets, as in fetchHttps above.
describe('production pane helper replacement', () => {
  const apps = [
    { app: 'word', host: 'Word', action: 'read_document' },
    { app: 'excel', host: 'Excel', action: 'read_range' },
    { app: 'powerpoint', host: 'PowerPoint', action: 'get_slides' },
  ] as const;
  type AppCase = typeof apps[number];
  type Trace = { at: number; event: string; [key: string]: unknown };
  const wallNow = Date.now.bind(Date);

  async function until(predicate: () => boolean, label: string): Promise<void> {
    // Real IO gets event-loop turns; fake time never advances implicitly here.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await realDelay(5);
    }
    throw new Error(`Fixture IO did not settle: ${label}`);
  }

  async function withPane(
    appCase: AppCase,
    run: (fixture: Awaited<ReturnType<typeof mountPane>>) => Promise<void>,
  ): Promise<void> {
    const trace: Trace[] = [];
    const mountCleanup: Array<() => Promise<void> | void> = [];
    let fixture: Awaited<ReturnType<typeof mountPane>> | undefined;
    try {
      fixture = await mountPane(appCase, trace, mountCleanup);
      await run(fixture);
    } finally {
      if (fixture) await fixture.dispose();
      else for (const cleanup of mountCleanup.reverse()) await cleanup();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      vi.doUnmock('../src/addin/commands/wordCommands.js');
      vi.doUnmock('../src/addin/commands/excelCommands.js');
      vi.doUnmock('../src/addin/commands/powerpointCommands.js');
    }
  }

  async function mountPane(appCase: AppCase, trace: Trace[], mountCleanup: Array<() => Promise<void> | void>) {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    // Production diagnostics include raw token prefixes; keep them out of proof
    // output. The trace below stores only token hashes and observed outcomes.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const record = (event: string, data: Record<string, unknown> = {}) => {
      const entry = { at: Date.now(), wallAt: wallNow(), event, ...data };
      trace.push(entry);

    };
    const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 12);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-production-pane-'));
    cleanupDirs.push(root);
    const stateDirectory = path.join(root, 'mcp', 'rebeloffice');
    const addinDir = path.join(root, 'addin');
    await fs.mkdir(addinDir, { recursive: true });
    const html = '<html><head></head><body><div id="status"><span id="status-text"></span></div>' +
      '<div id="status-detail"></div><button id="retry-connect"></button><div id="command-log"></div>' +
      '<div id="chat-root"></div></body></html>';
    await fs.writeFile(path.join(addinDir, 'taskpane.html'), html);
    const streams = new Set<http.ServerResponse>();
    const bridge = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const route = req.url ?? '';
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
        if (route === '/host/mint-app-token') {
          if (req.headers.authorization !== 'Bearer fictional-router-token') {
            res.writeHead(401).end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            ok: true, token: 'fictional-server-only-paired-token', appId: body['appId'], clientId: body['clientId'],
          }));
          return;
        }
        if (route.endsWith('/stream')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('event: connected\ndata: {"conversationId":"fictional-conversation","turnStatus":"idle"}\n\n');
          streams.add(res);
          res.once('close', () => streams.delete(res));
          return;
        }
        record('bridge.intent', { route, documentContext: body['documentContext'] });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          success: true, conversationId: 'fictional-conversation',
          ...(route.endsWith('/create') ? { state: 'new' } : {}),
          ...(route.endsWith('/message') ? { messageId: 'fictional-message', state: 'submitted', queueSize: 0 } : {}),
          ...(route.endsWith('/messages') ? { messages: [], turnStatus: 'idle' } : {}),
          ...(route.endsWith('/focus') ? { focused: true } : {}),
        }));
      });
    });
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    mountCleanup.push(async () => {
      for (const stream of streams) stream.end();
      bridge.closeAllConnections();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    });
    const bridgeAddress = bridge.address();
    if (!bridgeAddress || typeof bridgeAddress === 'string') throw new Error('Fixture bridge did not bind');
    const bridgeStateDir = path.join(root, 'mcp', 'rebel-app-bridge');
    await fs.mkdir(bridgeStateDir, { recursive: true });
    await fs.writeFile(path.join(bridgeStateDir, 'state.json'), JSON.stringify({
      port: bridgeAddress.port, pid: process.pid, protocolVersion: '1.0',
      startedAt: 'fictional-bridge-instance', routerToken: 'fictional-router-token', appTokens: [],
    }), { mode: 0o600 });
    const { startOfficeSidecar: startHelper, __resetBridgeAuthCacheForTests: resetBridgeCache } =
      await import('../src/sidecar/index.js');
    resetBridgeCache();
    let helper: OfficeSidecar | null = await startHelper({ port: 0, stateDirectory, addinDir, installToWefFolders: false });
    mountCleanup.push(async () => { if (helper) await helper.stop(); });
    const a = helper;
    const port = a.port;
    record('helper.A', { port, tokenHash: tokenHash(a.token) });
    const sockets: WebSocket[] = [];
    const requests = new Set<http.ClientRequest>();
    const responseBodies = new Set<http.IncomingMessage>();
    mountCleanup.push(() => {
      for (const socket of sockets) socket.terminate();
      for (const response of responseBodies) response.destroy();
      for (const req of requests) req.destroy();
    });
    const dom = new Window({ url: `https://127.0.0.1:${port}/taskpane.html` });
    mountCleanup.push(async () => { await dom.happyDOM.close(); });
    dom.document.write(html);
    dom.localStorage.clear();
    const statusObserver = new dom.MutationObserver(() => {
      record('pane.status', { status: dom.document.getElementById('status')!.className });
    });
    statusObserver.observe(dom.document.getElementById('status')!, { attributes: true, attributeFilter: ['class'] });
    mountCleanup.push(() => statusObserver.disconnect());
    const fetchFixture = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), dom.location.href);
      if (url.origin !== dom.location.origin) throw new Error('Fixture fetch escaped its helper origin');
      const headers = new Headers(init?.headers);
      const bearer = headers.get('authorization')?.replace(/^Bearer /, '');
      record('fetch', { route: url.pathname, ...(bearer ? { tokenHash: tokenHash(bearer) } : {}) });
      const fetchFailure = (cause: unknown): unknown => init?.signal?.aborted
        ? init.signal.reason : new TypeError('Failed to fetch', { cause });
      return await new Promise<Response>((resolve, reject) => {
        const req = https.request(url, {
          method: init?.method ?? 'GET', headers: Object.fromEntries(headers.entries()),
          rejectUnauthorized: false, agent: false, ...(init?.signal ? { signal: init.signal } : {}),
        }, (res) => {
          responseBodies.add(res);
          res.once('close', () => responseBodies.delete(res));
          record('fetch.response', {
            route: url.pathname, status: res.statusCode, ...(bearer ? { tokenHash: tokenHash(bearer) } : {}),
          });
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          let settled = false;
          let abortBody: (() => void) | undefined;
          const body = res.statusCode === 204 ? null : new ReadableStream<Uint8Array>({
            start(controller) {
              const fail = (cause: unknown) => {
                if (settled) return;
                settled = true;
                if (abortBody) init?.signal?.removeEventListener('abort', abortBody);
                const error = fetchFailure(cause);
                record('fetch.body.error', { route: url.pathname, name: error instanceof Error ? error.name : typeof error });
                controller.error(error);
                res.destroy();
              };
              res.on('data', (chunk: Buffer) => {
                if (settled) return;
                controller.enqueue(new Uint8Array(chunk));
                if ((controller.desiredSize ?? 0) <= 0) res.pause();
              });
              res.once('end', () => {
                if (settled) return;
                settled = true;
                if (abortBody) init?.signal?.removeEventListener('abort', abortBody);
                controller.close();
              });
              res.once('error', fail);
              res.once('aborted', () => fail(new Error('Response aborted')));
              abortBody = () => fail(init?.signal?.reason);
              init?.signal?.addEventListener('abort', abortBody, { once: true });
              res.pause();
              if (init?.signal?.aborted) abortBody();
            },
            pull() { if (!settled) res.resume(); },
            cancel() {
              settled = true;
              if (abortBody) init?.signal?.removeEventListener('abort', abortBody);
              res.destroy();
            },
          }, { highWaterMark: 1 });
          if (body === null) res.resume();
          const response = new Response(body, { status: res.statusCode, headers: responseHeaders });
          Object.defineProperty(response, 'url', { value: url.toString() });
          resolve(response);
        });
        requests.add(req);
        req.once('close', () => requests.delete(req));
        req.once('error', (cause) => {
          const error = fetchFailure(cause);
          record('fetch.error', { route: url.pathname, name: error instanceof Error ? error.name : typeof error });
          reject(error);
        });
        if (typeof init?.body === 'string') req.write(init.body);
        req.end();
      });
    }) as typeof fetch;
    class FixtureWebSocket extends WebSocket {
      constructor(url: string) {
        if (url !== `wss://127.0.0.1:${port}/ws`) throw new Error('Fixture socket escaped its helper');
        super(url, { rejectUnauthorized: false });
        sockets.push(this);
        const socketId = sockets.length;
        this.on('open', () => record('ws.open', { socketId }));
        this.on('close', (code) => record('ws.close', { socketId, code }));
        this.on('message', (raw) => {
          const message = JSON.parse(raw.toString()) as { type?: string };
          if (message.type === 'registered') record('ws.registered.ack', { socketId });
        });
      }
      override send(data: WebSocket.Data, ...args: unknown[]): void {
        const message = JSON.parse(String(data)) as { type: string; token?: string; app?: string };
        const socketId = sockets.indexOf(this) + 1;
        if (message.type === 'auth') record('ws.auth', { socketId, tokenHash: tokenHash(message.token ?? '') });
        if (message.type === 'register') record('ws.register.sent', { socketId, app: message.app });
        Reflect.apply(super.send, this, [data, ...args]);
      }
    }
    let ready: ((info: { host: string }) => void) | undefined;
    const settings = new Map<string, unknown>();
    const officeDocument = {
      url: `https://example.com/fictional-${appCase.app}.document`,
      settings: {
        get: (key: string) => settings.get(key),
        set: (key: string, value: unknown) => { settings.set(key, value); },
        saveAsync: (callback: (result: { status: string }) => void) => callback({ status: 'succeeded' }),
      },
    };
    vi.stubGlobal('window', dom);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('localStorage', dom.localStorage);
    vi.stubGlobal('fetch', fetchFixture);
    vi.stubGlobal('WebSocket', FixtureWebSocket);
    vi.stubGlobal('Office', {
      onReady: vi.fn((callback: typeof ready) => { ready = callback; }),
      context: { document: officeDocument },
    });
    const readExecutor = vi.fn(async () => ({ success: true as const, data: { text: 'Fictional document content' } }));
    for (const [module, exportName] of [
      ['wordCommands', 'getWordCommandHandler'], ['excelCommands', 'getExcelCommandHandler'],
      ['powerpointCommands', 'getPowerpointCommandHandler'],
    ]) {
      vi.doMock(`../src/addin/commands/${module}.js`, () => ({
        [exportName!]: (action: string) => action === appCase.action ? readExecutor : null,
      }));
    }
    const controllerModule = await import('../src/shared/chatController/controller.js');
    const controllerSpy = vi.spyOn(controllerModule, 'createChatController');
    const clientModule = await import('../src/addin/websocket.js');
    const connectSpy = vi.spyOn(clientModule.SidecarWebSocketClient.prototype, 'connect');
    const chatModule = await import('../src/addin/chatUI.js');
    const uiSpy = vi.spyOn(chatModule, 'createChatUI');
    // Read A's real bootstrap; never install B manually in the pane.
    const bootstrap = await fetchFixture(`${dom.location.origin}/taskpane.html`);
    const assignment = /window\.__REBEL_SIDECAR_CONFIG=(\{[^<]*?\});/.exec(await bootstrap.text());
    expect(bootstrap.status).toBe(200);
    expect(assignment).not.toBeNull();
    const config = JSON.parse(assignment![1]!) as { token: string; port: number; bridgeReady: boolean };
    expect(config.bridgeReady).toBe(true);
    Object.assign(dom, { __REBEL_SIDECAR_CONFIG: config });
    const taskpane = await import('../src/addin/taskpane.js');
    expect(typeof taskpane.initializeTaskpane).toBe('function');
    expect(Office.onReady).toHaveBeenCalledTimes(1);
    expect(ready).toBeTypeOf('function');
    ready!({ host: appCase.host });
    expect(uiSpy.mock.calls[0]![0].commandState).toBe('authenticating');
    await until(() => controllerSpy.mock.results.length === 1, 'production chat controller');
    const controller = controllerSpy.mock.results[0]!.value as ReturnType<typeof controllerModule.createChatController>;
    await until(() => controller.getSnapshot().phase === 'idle', 'initial chat hydration');
    const client = connectSpy.mock.contexts[0] as InstanceType<typeof clientModule.SidecarWebSocketClient>;
    mountCleanup.push(() => { controller.dispose(); client.disconnect(); });
    let registered = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await fetchHttps(`${dom.location.origin}/health`);
      const payload = await response.json() as { connected: Record<string, boolean> };
      if (payload.connected[appCase.app]) { registered = true; break; }
      await realDelay(5);
    }
    expect(registered, 'baseline A registered through actual initializeTaskpane').toBe(true);
    const read = async (sidecar: OfficeSidecar) => {
      const response = await fetchHttps(`${dom.location.origin}/${appCase.app}/${appCase.action}`, {
        method: 'POST', headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' }, body: '{}',
      });
      const result = await response.json() as { success: boolean; code?: string; data?: unknown };
      record('read.result', { status: response.status, success: result.success, code: result.code });
      return result;
    };
    expect(await read(a)).toEqual({ success: true, data: { text: 'Fictional document content' } });
    expect(readExecutor).toHaveBeenCalledTimes(1);
    await controller.send('Start a fictional conversation');
    await until(() => controller.getSnapshot().phase === 'idle', 'baseline conversation stream idle');
    expect(controller.getSnapshot().conversationId).toBe('fictional-conversation');
    // The production provider intentionally sends host/title, not the document
    // URL. Establish that nonempty contract through actual taskpane capture.
    const title = `fictional-${appCase.app}.document`;
    const contextProvider = controllerSpy.mock.calls[0]![0].context!;
    const establishedDocumentContext = structuredClone(await contextProvider.captureContext());
    expect(establishedDocumentContext).toEqual({
      documentContext: { host: appCase.app, title }, pageContext: { title },
    });
    const establishedConversationContext = structuredClone(controller.getSnapshot().conversationContext);
    expect(establishedConversationContext).toEqual({ pageTitle: title });
    expect(trace.find((entry) => entry.event === 'bridge.intent' && String(entry['route']).endsWith('/create'))?.['documentContext'])
      .toEqual({ host: appCase.app, title });
    const baselineChatRequests = trace.filter((entry) => entry.event === 'fetch' && String(entry['route']).startsWith('/intent/'));
    expect(baselineChatRequests.length).toBeGreaterThan(0);
    expect(baselineChatRequests.every((entry) => entry['tokenHash'] === tokenHash(a.token))).toBe(true);
    expect(controller.getSnapshot().error).toBeNull();
    const textarea = dom.document.querySelector('.chat-composer-textarea') as unknown as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    textarea.value = 'Preserve this unsent fictional draft';
    textarea.dispatchEvent(new dom.Event('input', { bubbles: true }));
    record('baseline.A.working', {
      registered, readSuccess: true, chatSuccess: true, contextEstablished: true, tokenHash: tokenHash(a.token),
    });
    const health = async () => {
      const response = await fetchHttps(`${dom.location.origin}/health`);
      return await response.json() as { connected: Record<string, boolean> };
    };
    const snapshot = async (event: string) => {
      const status = dom.document.getElementById('status')!.className;
      record(event, {
        status, clientState: client.state, cellTokenHash: tokenHash(config.token),
        phase: controller.getSnapshot().phase, errorCode: controller.getSnapshot().error?.code,
        connected: helper ? (await health()).connected[appCase.app] : false,
      });
    };
    const stopA = async () => {
      // Test-owned transport termination models helper exit without disposing
      // or reconstructing the production pane/client/controller.
      for (const socket of sockets) socket.terminate();
      await a.stop();
      helper = null;
      for (const stream of streams) stream.end();
      await until(() => client.state === 'disconnected', 'helper A exit observed');
      record('helper.A.stopped');
    };
    const startB = async () => {
      helper = await startHelper({ port, stateDirectory, addinDir, installToWefFolders: false });
      expect(helper.port).toBe(port);
      expect(helper.token === a.token).toBe(false);
      record('helper.B.started', { port, tokenHash: tokenHash(helper.token) });
      return helper;
    };
    const advance = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await realDelay(50);
    };
    const recoverChatOnB = async (b: OfficeSidecar) => {
      const bHash = tokenHash(b.token);
      const streamRecovered = () => trace.some((entry) => entry.event === 'fetch.response' &&
        String(entry['route']).endsWith('/stream') && entry['tokenHash'] === bHash && entry['status'] === 200);
      const ready = () => streamRecovered() && controller.getSnapshot().phase === 'idle' &&
        controller.getSnapshot().error === null;
      let additionalVirtualMs = 0;
      for (let step = 0; step < 15 && !ready(); step += 1) {
        await advance(1_000);
        additionalVirtualMs += 1_000;
      }
      record('recovery.before-focus', {
        additionalVirtualMs, phase: controller.getSnapshot().phase,
        errorCode: controller.getSnapshot().error?.code ?? null, success: ready(), tokenHash: bHash,
      });
      expect.soft(trace.some((entry) => entry.event === 'fetch' &&
        String(entry['route']).endsWith('/stream') && entry['tokenHash'] === bHash), 'real stream request carries B').toBe(true);
      expect.soft(streamRecovered(), 'B stream responds HTTP 200 before focus').toBe(true);
      expect.soft(controller.getSnapshot().phase, 'chat recovered before focus').toBe('idle');
      expect.soft(controller.getSnapshot().error, 'stream recovery clears the error before focus').toBeNull();
      const afterB = trace.slice(trace.findIndex((entry) => entry.event === 'helper.B.started'));
      const history = afterB.filter((entry) => entry.event === 'fetch' && String(entry['route']).endsWith('/messages'));
      if (history.length > 0) {
        expect.soft(history.at(-1)?.['tokenHash'], 'production history restore carries B').toBe(bHash);
        const responses = afterB.filter((entry) => entry.event === 'fetch.response' && String(entry['route']).endsWith('/messages'));
        expect.soft(responses.at(-1)).toMatchObject({ tokenHash: bHash, status: 200 });
      }
      record('recovery.history', { success: history.length > 0 ? afterB.some((entry) => entry.event === 'fetch.response' &&
        String(entry['route']).endsWith('/messages') && entry['tokenHash'] === bHash && entry['status'] === 200) : null });
    };
    const preserved = async () => {
      expect.soft(controllerSpy).toHaveBeenCalledTimes(1);
      expect.soft(uiSpy).toHaveBeenCalledTimes(1);
      expect.soft(connectSpy.mock.contexts.every((instance) => instance === client)).toBe(true);
      expect.soft(dom.document.querySelector('.chat-composer-textarea')).toBe(textarea);
      expect.soft(textarea.value).toBe('Preserve this unsent fictional draft');
      expect.soft(controller.getSnapshot().conversationId).toBe('fictional-conversation');
      const currentDocumentContext = await contextProvider.captureContext();
      expect.soft(currentDocumentContext).toEqual(establishedDocumentContext);
      expect.soft(controller.getSnapshot().conversationContext).toEqual(establishedConversationContext);
      record('preservation.observed', {
        contextPreserved: JSON.stringify(currentDocumentContext) === JSON.stringify(establishedDocumentContext) &&
          JSON.stringify(controller.getSnapshot().conversationContext) === JSON.stringify(establishedConversationContext),
        instancesPreserved: controllerSpy.mock.calls.length === 1 && uiSpy.mock.calls.length === 1 &&
          connectSpy.mock.contexts.every((instance) => instance === client) &&
          dom.document.querySelector('.chat-composer-textarea') === textarea &&
          textarea.value === 'Preserve this unsent fictional draft' &&
          controller.getSnapshot().conversationId === 'fictional-conversation',
      });
    };
    return {
      trace, record, a, read, stopA, startB, advance, health, snapshot, preserved, recoverChatOnB, controller, config, tokenHash, readExecutor, client,
      closed: () => dom.document.getElementById('status')!.classList.contains('rebel-closed'),
      async dispose() {
        statusObserver.disconnect();
        dom.dispatchEvent(new dom.Event('beforeunload'));
        client.disconnect();
        for (const socket of sockets) socket.terminate();
        for (const stream of streams) stream.end();
        for (const response of responseBodies) response.destroy();
        for (const req of requests) req.destroy();
        if (helper) await helper.stop();
        bridge.closeAllConnections();
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
        await dom.happyDOM.close();
        vi.clearAllTimers();
        resetBridgeCache();
        record('fixture.disposed');
      },
    };
  }

  it.each(apps)('recovers the same production pane/default runtime for $app', async (appCase) => {
    await withPane(appCase, async (fixture) => {
      await fixture.stopA();
      const b = await fixture.startB();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await fixture.advance(1_000);
        if ((await fixture.health()).connected[appCase.app]) break;
      }
      await fixture.snapshot('replacement.observed');
      const bConnected = (await fixture.health()).connected[appCase.app];
      expect.soft(bConnected, 'helper B registers the existing production pane').toBe(true);
      expect.soft((await fixture.read(b)).success, 'read through helper B').toBe(true);
      await fixture.recoverChatOnB(b);
      await fixture.controller.openInRebel();
      const nextChat = fixture.controller.getSnapshot().error?.code ?? 'ok';
      fixture.record('subsequent.chat.result', { result: nextChat });
      const focusRequests = fixture.trace.filter((entry) => entry.event === 'fetch' && String(entry['route']).endsWith('/focus'));
      expect.soft(focusRequests.length).toBeGreaterThan(0);
      expect.soft(focusRequests.at(-1)?.['tokenHash'], 'subsequent default chat sends bearer B').toBe(fixture.tokenHash(b.token));
      const focusResponses = fixture.trace.filter((entry) => entry.event === 'fetch.response' && String(entry['route']).endsWith('/focus'));
      expect.soft(focusResponses.at(-1)).toMatchObject({ tokenHash: fixture.tokenHash(b.token), status: 200 });
      expect.soft(nextChat).toBe('ok');
      await fixture.preserved();
      await fixture.snapshot('replacement.after-chat');
    });
  });

  it('lazy absence recovers the pending triggering call within its original deadline', async () => {
    await withPane(apps[0], async (fixture) => {
      await fixture.stopA();
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) await fixture.advance(delay);
      expect(fixture.closed(), 'actual initialized taskpane reaches rebel-closed').toBe(true);
      await fixture.snapshot('lazy.closed-before-operation');
      const b = await fixture.startB();
      const callTime = Date.now();
      let settled = false;
      const pending = fixture.read(b).then((result) => { settled = true; return result; });
      await realDelay(50);
      expect(settled).toBe(false);
      expect(fixture.readExecutor).toHaveBeenCalledTimes(1); // Only A's baseline.
      expect((await fixture.health()).connected.word).toBe(false);
      fixture.record('lazy.triggering.pending');
      // Only timers scheduled by production discovery/reconnect/deadline run.
      for (let step = 0; step < 29 && !settled; step += 1) await fixture.advance(1_000);
      expect(settled, 'trigger completes before its original 30s deadline').toBe(true);
      const triggering = await pending;
      fixture.record('lazy.triggering.result', { success: triggering.success, code: triggering.code });
      expect(triggering.success).toBe(true);
      expect(Date.now() - callTime).toBeLessThan(30_000);
      expect(fixture.client.state).toBe('connected');
      expect(fixture.trace.filter((entry) => entry.event === 'ws.registered.ack')).toHaveLength(2);
      expect(fixture.readExecutor).toHaveBeenCalledTimes(2);
      const following = await fixture.read(b);
      fixture.record('lazy.immediate-following.result', { success: following.success, code: following.code });
      expect(following.success).toBe(true);
      expect(fixture.readExecutor).toHaveBeenCalledTimes(3);
      await fixture.recoverChatOnB(b);
      try {
        await fixture.controller.openInRebel();
        const chatResult = fixture.controller.getSnapshot().error?.code ?? 'ok';
        fixture.record('lazy.subsequent-chat.result', { result: chatResult });
        expect(chatResult).toBe('ok');
        const focus = fixture.trace.filter((entry) => entry.event === 'fetch' && String(entry['route']).endsWith('/focus'));
        expect(focus.at(-1)?.['tokenHash']).toBe(fixture.tokenHash(b.token));
        const focusResponses = fixture.trace.filter((entry) => entry.event === 'fetch.response' && String(entry['route']).endsWith('/focus'));
        expect(focusResponses.at(-1)).toMatchObject({ tokenHash: fixture.tokenHash(b.token), status: 200 });
      } finally {
        await fixture.preserved();
      }
    });
  });
});
