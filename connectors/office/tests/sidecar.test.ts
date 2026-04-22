import * as fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(constantTimeSpy).toHaveBeenCalledWith(sidecar.token, sidecar.token);
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
    const { sidecar, baseUrl } = await startTestServer();
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
    const { sidecar, baseUrl } = await startTestServer();

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
