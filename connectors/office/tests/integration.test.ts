import * as fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { startOfficeSidecar, type OfficeSidecar } from '../src/sidecar/index.js';

// ---------------------------------------------------------------------------
// HTTPS helpers for testing (sidecar uses office-addin-dev-certs)
// ---------------------------------------------------------------------------

async function fetchHttps(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; json: () => Promise<unknown> }> {
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
            json: () => Promise.resolve(JSON.parse(body) as unknown),
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type TestServer = {
  sidecar: OfficeSidecar;
  stateDir: string;
  baseUrl: string;
};

const cleanupServers: OfficeSidecar[] = [];
const cleanupDirs: string[] = [];
const cleanupSockets: WebSocket[] = [];

async function startTestServer(options: Parameters<typeof startOfficeSidecar>[0] = {}): Promise<TestServer> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-integration-test-'));
  cleanupDirs.push(stateDir);

  const sidecar = await startOfficeSidecar({
    stateDirectory: stateDir,
    port: 0,
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
    cleanupSockets.push(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function sendJson(socket: WebSocket, payload: unknown): void {
  socket.send(JSON.stringify(payload));
}

async function waitForConnection(baseUrl: string, app: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetchHttps(`${baseUrl}/health`);
    const payload = (await response.json()) as { connected: Record<string, boolean> };
    if (payload.connected?.[app] === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${app} registration`);
}

async function waitForDisconnection(baseUrl: string, app: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetchHttps(`${baseUrl}/health`);
    const payload = (await response.json()) as { connected: Record<string, boolean> };
    if (payload.connected?.[app] === false) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${app} disconnection`);
}

async function authenticateAndRegister(
  socket: WebSocket,
  token: string,
  app: string,
  baseUrl: string,
): Promise<void> {
  sendJson(socket, { type: 'auth', token });
  sendJson(socket, { type: 'register', app, version: '1.0.0' });
  await waitForConnection(baseUrl, app);
}

function setupAutoResponse(socket: WebSocket, responseData: unknown = { result: 'ok' }): void {
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as { type?: string; id?: string };
    if (message.type === 'command' && typeof message.id === 'string') {
      sendJson(socket, {
        type: 'response',
        id: message.id,
        success: true,
        data: responseData,
      });
    }
  });
}

afterEach(async () => {
  while (cleanupSockets.length > 0) {
    const socket = cleanupSockets.pop();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }

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

// ---------------------------------------------------------------------------
// Integration tests: full MCP → sidecar → mock add-in pipeline
// ---------------------------------------------------------------------------

describe('integration: MCP → sidecar → add-in pipeline', () => {
  it('full roundtrip: HTTP POST → sidecar → mock Word add-in → HTTP response', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    await authenticateAndRegister(socket, sidecar.token, 'word', baseUrl);

    // Set up mock add-in to capture command and return response
    const commandReceived = new Promise<{ action: string; params: Record<string, unknown> }>((resolve) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          id?: string;
          action?: string;
          params?: Record<string, unknown>;
        };
        if (msg.type === 'command' && typeof msg.id === 'string') {
          sendJson(socket, {
            type: 'response',
            id: msg.id,
            success: true,
            data: { paragraphs: ['Hello', 'World'], totalCount: 2 },
          });
          resolve({ action: msg.action ?? '', params: msg.params ?? {} });
        }
      });
    });

    const response = await fetchHttps(`${baseUrl}/word/read_document`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sidecar.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ maxParagraphs: 100, includeFormatting: true }),
    });

    const payload = (await response.json()) as { success: boolean; data: unknown };
    const routed = await commandReceived;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data).toEqual({ paragraphs: ['Hello', 'World'], totalCount: 2 });
    expect(routed.action).toBe('read_document');
    expect(routed.params).toEqual({ maxParagraphs: 100, includeFormatting: true });
  });

  it('routes commands to the correct app when word and excel are both connected', async () => {
    const { sidecar, baseUrl } = await startTestServer();

    // Connect both Word and Excel
    const wordSocket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(wordSocket, sidecar.token, 'word', baseUrl);

    const excelSocket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(excelSocket, sidecar.token, 'excel', baseUrl);

    // Track which commands each mock add-in receives
    const wordActions: string[] = [];
    wordSocket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; id?: string; action?: string };
      if (msg.type === 'command' && typeof msg.id === 'string') {
        wordActions.push(msg.action ?? '');
        sendJson(wordSocket, { type: 'response', id: msg.id, success: true, data: { source: 'word' } });
      }
    });

    const excelActions: string[] = [];
    excelSocket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; id?: string; action?: string };
      if (msg.type === 'command' && typeof msg.id === 'string') {
        excelActions.push(msg.action ?? '');
        sendJson(excelSocket, { type: 'response', id: msg.id, success: true, data: { source: 'excel' } });
      }
    });

    // Send Word command
    const wordRes = await fetchHttps(`${baseUrl}/word/read_document`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const wordPayload = (await wordRes.json()) as { data: { source: string } };

    // Send Excel command
    const excelRes = await fetchHttps(`${baseUrl}/excel/read_range`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: 'A1:B5' }),
    });
    const excelPayload = (await excelRes.json()) as { data: { source: string } };

    // Verify each command reached only its target add-in
    expect(wordPayload.data.source).toBe('word');
    expect(excelPayload.data.source).toBe('excel');
    expect(wordActions).toEqual(['read_document']);
    expect(excelActions).toEqual(['read_range']);
  });

  it('health endpoint reflects WebSocket connection and disconnection', async () => {
    const { sidecar, baseUrl } = await startTestServer();

    // Initially all disconnected
    const initial = (await (await fetchHttps(`${baseUrl}/health`)).json()) as {
      connected: { word: boolean; excel: boolean; powerpoint: boolean };
    };
    expect(initial.connected).toEqual({ word: false, excel: false, powerpoint: false });

    // Connect Word
    const socket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(socket, sidecar.token, 'word', baseUrl);

    const afterConnect = (await (await fetchHttps(`${baseUrl}/health`)).json()) as {
      connected: { word: boolean; excel: boolean; powerpoint: boolean };
    };
    expect(afterConnect.connected.word).toBe(true);
    expect(afterConnect.connected.excel).toBe(false);
    expect(afterConnect.connected.powerpoint).toBe(false);

    // Disconnect Word
    socket.close();
    await waitForDisconnection(baseUrl, 'word');

    const afterDisconnect = (await (await fetchHttps(`${baseUrl}/health`)).json()) as {
      connected: { word: boolean; excel: boolean; powerpoint: boolean };
    };
    expect(afterDisconnect.connected.word).toBe(false);
  });

  it('returns friendly error when target app is not connected', async () => {
    const { sidecar, baseUrl } = await startTestServer();

    // Send to Word — not connected
    const wordRes = await fetchHttps(`${baseUrl}/word/read_document`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const wordPayload = (await wordRes.json()) as {
      success: false;
      error: string;
      code: string;
      app: string;
    };

    expect(wordRes.status).toBe(503);
    expect(wordPayload.success).toBe(false);
    expect(wordPayload.code).toBe('APP_NOT_CONNECTED');
    expect(wordPayload.app).toBe('word');
    expect(wordPayload.error).toContain("Word isn't connected");

    // Send to Excel — not connected
    const excelRes = await fetchHttps(`${baseUrl}/excel/read_range`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const excelPayload = (await excelRes.json()) as {
      success: false;
      error: string;
      code: string;
      app: string;
    };

    expect(excelRes.status).toBe(503);
    expect(excelPayload.code).toBe('APP_NOT_CONNECTED');
    expect(excelPayload.app).toBe('excel');
    expect(excelPayload.error).toContain("Excel isn't connected");

    // Send to PowerPoint — not connected
    const pptRes = await fetchHttps(`${baseUrl}/powerpoint/get_slides`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const pptPayload = (await pptRes.json()) as {
      success: false;
      error: string;
      code: string;
      app: string;
    };

    expect(pptRes.status).toBe(503);
    expect(pptPayload.code).toBe('APP_NOT_CONNECTED');
    expect(pptPayload.app).toBe('powerpoint');
    expect(pptPayload.error).toContain("PowerPoint isn't connected");
  });

  it('rejects unauthenticated HTTP requests and accepts authenticated ones', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(socket, sidecar.token, 'word', baseUrl);
    setupAutoResponse(socket);

    // No Authorization header
    const noAuth = await fetchHttps(`${baseUrl}/word/read_document`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(noAuth.status).toBe(401);
    const noAuthPayload = (await noAuth.json()) as { code: string };
    expect(noAuthPayload.code).toBe('UNAUTHORIZED');

    // Wrong token
    const badAuth = await fetchHttps(`${baseUrl}/word/read_document`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token-value', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(badAuth.status).toBe(401);

    // Valid token
    const goodAuth = await fetchHttps(`${baseUrl}/word/read_document`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(goodAuth.status).toBe(200);
    const goodPayload = (await goodAuth.json()) as { success: boolean };
    expect(goodPayload.success).toBe(true);
  });

  it('routes Excel commands to connected Excel add-in', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    await authenticateAndRegister(socket, sidecar.token, 'excel', baseUrl);

    const commandReceived = new Promise<{ action: string; params: Record<string, unknown> }>((resolve) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string; id?: string; action?: string; params?: Record<string, unknown>;
        };
        if (msg.type === 'command' && typeof msg.id === 'string') {
          sendJson(socket, {
            type: 'response', id: msg.id, success: true,
            data: { values: [['A', 'B'], [1, 2]], totalRows: 2, returnedRows: 2 },
          });
          resolve({ action: msg.action ?? '', params: msg.params ?? {} });
        }
      });
    });

    const response = await fetchHttps(`${baseUrl}/excel/read_range`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: 'A1:B3', worksheet: 'Sheet1', hasHeaders: true }),
    });

    const payload = (await response.json()) as { success: boolean; data: unknown };
    const routed = await commandReceived;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(routed.action).toBe('read_range');
    expect(routed.params).toEqual({ range: 'A1:B3', worksheet: 'Sheet1', hasHeaders: true });
  });

  it('routes PowerPoint commands to connected PowerPoint add-in', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    await authenticateAndRegister(socket, sidecar.token, 'powerpoint', baseUrl);

    const commandReceived = new Promise<{ action: string; params: Record<string, unknown> }>((resolve) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string; id?: string; action?: string; params?: Record<string, unknown>;
        };
        if (msg.type === 'command' && typeof msg.id === 'string') {
          sendJson(socket, {
            type: 'response', id: msg.id, success: true,
            data: { slideCount: 5, slides: [{ slideNumber: 1, title: 'Intro' }] },
          });
          resolve({ action: msg.action ?? '', params: msg.params ?? {} });
        }
      });
    });

    const response = await fetchHttps(`${baseUrl}/powerpoint/get_slides`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 50 }),
    });

    const payload = (await response.json()) as { success: boolean; data: unknown };
    const routed = await commandReceived;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(routed.action).toBe('get_slides');
    expect(routed.params).toEqual({ limit: 50 });
  });

  it('routes commands to all three apps simultaneously', async () => {
    const { sidecar, baseUrl } = await startTestServer();

    // Connect all three apps
    const wordSocket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(wordSocket, sidecar.token, 'word', baseUrl);
    setupAutoResponse(wordSocket, { source: 'word' });

    const excelSocket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(excelSocket, sidecar.token, 'excel', baseUrl);
    setupAutoResponse(excelSocket, { source: 'excel' });

    const pptSocket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(pptSocket, sidecar.token, 'powerpoint', baseUrl);
    setupAutoResponse(pptSocket, { source: 'powerpoint' });

    // Verify health shows all three connected
    const health = (await (await fetchHttps(`${baseUrl}/health`)).json()) as {
      connected: { word: boolean; excel: boolean; powerpoint: boolean };
    };
    expect(health.connected).toEqual({ word: true, excel: true, powerpoint: true });

    // Fire commands to all three in parallel
    const [wordRes, excelRes, pptRes] = await Promise.all([
      fetchHttps(`${baseUrl}/word/read_document`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      fetchHttps(`${baseUrl}/excel/get_worksheets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      fetchHttps(`${baseUrl}/powerpoint/get_slides`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
        body: '{}',
      }),
    ]);

    const wordPayload = (await wordRes.json()) as { data: { source: string } };
    const excelPayload = (await excelRes.json()) as { data: { source: string } };
    const pptPayload = (await pptRes.json()) as { data: { source: string } };

    expect(wordPayload.data.source).toBe('word');
    expect(excelPayload.data.source).toBe('excel');
    expect(pptPayload.data.source).toBe('powerpoint');
  });

  it('Excel error responses propagate correctly through the pipeline', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    await authenticateAndRegister(socket, sidecar.token, 'excel', baseUrl);

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
      if (msg.type === 'command' && typeof msg.id === 'string') {
        sendJson(socket, {
          type: 'response', id: msg.id, success: false,
          error: 'The range "ZZZ999" is invalid.', code: 'INVALID_ARGUMENT',
        });
      }
    });

    const response = await fetchHttps(`${baseUrl}/excel/read_range`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: 'ZZZ999' }),
    });

    const payload = (await response.json()) as { success: false; error: string; code: string };
    expect(response.status).toBe(200);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('ZZZ999');
    expect(payload.code).toBe('INVALID_ARGUMENT');
  });

  it('PowerPoint error responses propagate correctly through the pipeline', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);

    await authenticateAndRegister(socket, sidecar.token, 'powerpoint', baseUrl);

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
      if (msg.type === 'command' && typeof msg.id === 'string') {
        sendJson(socket, {
          type: 'response', id: msg.id, success: false,
          error: 'Slide index 99 out of range.', code: 'ITEM_NOT_FOUND',
        });
      }
    });

    const response = await fetchHttps(`${baseUrl}/powerpoint/get_slide_content`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ slideIndex: 99 }),
    });

    const payload = (await response.json()) as { success: false; error: string; code: string };
    expect(response.status).toBe(200);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('99');
  });

  it('disconnecting one app does not affect others', async () => {
    const { sidecar, baseUrl } = await startTestServer();

    const wordSocket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(wordSocket, sidecar.token, 'word', baseUrl);
    setupAutoResponse(wordSocket, { source: 'word' });

    const excelSocket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(excelSocket, sidecar.token, 'excel', baseUrl);
    setupAutoResponse(excelSocket, { source: 'excel' });

    // Disconnect Word
    wordSocket.close();
    await waitForDisconnection(baseUrl, 'word');

    // Excel should still work
    const excelRes = await fetchHttps(`${baseUrl}/excel/get_worksheets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(excelRes.status).toBe(200);
    const excelPayload = (await excelRes.json()) as { data: { source: string } };
    expect(excelPayload.data.source).toBe('excel');

    // Word should fail
    const wordRes = await fetchHttps(`${baseUrl}/word/read_document`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(wordRes.status).toBe(503);
    const wordPayload = (await wordRes.json()) as { code: string };
    expect(wordPayload.code).toBe('APP_NOT_CONNECTED');
  });

  it('accepts commands after client disconnects and reconnects', async () => {
    const { sidecar, baseUrl } = await startTestServer();

    // First connection
    const socket1 = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(socket1, sidecar.token, 'word', baseUrl);
    setupAutoResponse(socket1, { version: 'v1' });

    const res1 = await fetchHttps(`${baseUrl}/word/get_properties`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res1.status).toBe(200);
    const payload1 = (await res1.json()) as { data: { version: string } };
    expect(payload1.data.version).toBe('v1');

    // Disconnect
    socket1.close();
    await waitForDisconnection(baseUrl, 'word');

    // Verify command fails while disconnected
    const failRes = await fetchHttps(`${baseUrl}/word/get_properties`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(failRes.status).toBe(503);

    // Reconnect with new socket
    const socket2 = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(socket2, sidecar.token, 'word', baseUrl);
    setupAutoResponse(socket2, { version: 'v2' });

    // Verify commands work again
    const res2 = await fetchHttps(`${baseUrl}/word/get_properties`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res2.status).toBe(200);
    const payload2 = (await res2.json()) as { data: { version: string } };
    expect(payload2.data.version).toBe('v2');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: Word table tools (read_table / update_table_cell)
// ---------------------------------------------------------------------------

describe('integration: Word table tools', () => {
  function captureCommand(socket: WebSocket, responseData: unknown) {
    const commandReceived = new Promise<{ action: string; params: Record<string, unknown> }>((resolve) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string; id?: string; action?: string; params?: Record<string, unknown>;
        };
        if (msg.type === 'command' && typeof msg.id === 'string') {
          sendJson(socket, { type: 'response', id: msg.id, success: true, data: responseData });
          resolve({ action: msg.action ?? '', params: msg.params ?? {} });
        }
      });
    });
    return commandReceived;
  }

  it('routes read_table with tableIndex and returns cell values', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(socket, sidecar.token, 'word', baseUrl);

    const commandReceived = captureCommand(socket, {
      tableIndex: 1,
      rowCount: 2,
      columnCount: 2,
      values: [['Name', 'Role'], ['Ada', 'Eng']],
    });

    const response = await fetchHttps(`${baseUrl}/word/read_table`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableIndex: 1 }),
    });

    const payload = (await response.json()) as { success: boolean; data: { values: string[][] } };
    const routed = await commandReceived;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.values).toEqual([['Name', 'Role'], ['Ada', 'Eng']]);
    expect(routed.action).toBe('read_table');
    expect(routed.params).toEqual({ tableIndex: 1 });
  });

  it('routes update_table_cell with all params', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(socket, sidecar.token, 'word', baseUrl);

    const commandReceived = captureCommand(socket, {
      success: true, tableIndex: 0, rowIndex: 1, columnIndex: 2,
    });

    const response = await fetchHttps(`${baseUrl}/word/update_table_cell`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableIndex: 0, rowIndex: 1, columnIndex: 2, text: 'Updated' }),
    });

    const payload = (await response.json()) as { success: boolean };
    const routed = await commandReceived;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(routed.action).toBe('update_table_cell');
    expect(routed.params).toEqual({ tableIndex: 0, rowIndex: 1, columnIndex: 2, text: 'Updated' });
  });

  it('propagates table errors (out-of-range index) from the add-in', async () => {
    const { sidecar, baseUrl } = await startTestServer();
    const socket = await connectWebSocket(sidecar.port);
    await authenticateAndRegister(socket, sidecar.token, 'word', baseUrl);

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; id?: string };
      if (msg.type === 'command' && typeof msg.id === 'string') {
        sendJson(socket, {
          type: 'response', id: msg.id, success: false,
          error: 'Table index 5 out of range. Document has 1 table(s) (0-based).',
          code: 'UNKNOWN_ERROR',
        });
      }
    });

    const response = await fetchHttps(`${baseUrl}/word/read_table`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sidecar.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableIndex: 5 }),
    });

    const payload = (await response.json()) as { success: boolean; error: string };
    expect(response.status).toBe(200);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('out of range');
  });
});
