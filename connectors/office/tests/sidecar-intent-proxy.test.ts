/**
 * Integration tests for the Office sidecar's `/intent/*` proxy.
 *
 * Covers:
 *   - Auth gate: missing / wrong sidecar Bearer → 401.
 *   - Bridge readiness: `ensureBridgeAuth` returns null → 503 BRIDGE_NOT_READY.
 *   - Path allowlist: `/intent/some/other` → 404.
 *   - Method allowlist: DELETE → 405.
 *   - JSON body stamping: POST /intent/conversation/create receives
 *     `appId: 'office-addin'` + the sidecar's `clientId` even when the
 *     task-pane didn't send them.
 *   - SSE passthrough: GET /intent/conversation/:id/stream streams the
 *     bridge's `text/event-stream` body through unchanged.
 *
 * We spin up a real Office sidecar (HTTPS on a random port), point it at
 * a fake bridge that records what it received. The `ensureBridgeAuth`
 * helper inside the sidecar is exercised for real — when the fake bridge
 * mint endpoint succeeds, the sidecar proxy forwards with the minted
 * `Bearer <paired-token>`.
 *
 * See `docs/plans/260423_office_addin_intent_proxy.md`.
 */

import http from 'node:http';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startOfficeSidecar,
  type OfficeSidecar,
  __resetBridgeAuthCacheForTests,
} from '../src/sidecar/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fake bridge — implements /host/mint-app-token + /intent/* routes well
// enough to let the proxy round-trip.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface FakeBridge {
  port: number;
  routerToken: string;
  startedAt: string;
  mintCallCount: number;
  lastMintBody: { appId: string; clientId: string } | null;
  lastIntentRequest: RecordedRequest | null;
  intentRequests: RecordedRequest[];
  /** Swap out to make the next /intent/* call return a specific status. */
  intentResponse: {
    status: number;
    headers: Record<string, string>;
    body: string | Buffer;
  };
  /**
   * When set, the fake bridge starts an SSE stream on the next
   * GET /intent/conversation/:id/stream call, writes the provided
   * frames (joined with double-newlines) and keeps the socket open
   * until `stopStream()` is called.
   */
  sseScript: string[] | null;
  stopStream: () => void;
  stop: () => Promise<void>;
}

async function startFakeBridge(): Promise<FakeBridge> {
  let stopStream = (): void => undefined;
  const state: FakeBridge = {
    port: 0,
    routerToken: 'router-token-x',
    startedAt: new Date().toISOString(),
    mintCallCount: 0,
    lastMintBody: null,
    lastIntentRequest: null,
    intentRequests: [],
    intentResponse: {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true }),
    },
    sseScript: null,
    stopStream: (): void => undefined,
    stop: async () => undefined,
  };

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'POST' && url === '/host/mint-app-token') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${state.routerToken}`) {
          res.writeHead(401).end();
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          appId: string;
          clientId: string;
        };
        state.mintCallCount += 1;
        state.lastMintBody = { appId: body.appId, clientId: body.clientId };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            token: `paired-token-${state.mintCallCount}`,
            appId: body.appId,
            clientId: body.clientId,
          }),
        );
      });
      return;
    }

    if (url.startsWith('/intent/')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        state.lastIntentRequest = {
          method,
          path: url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        state.intentRequests.push(state.lastIntentRequest);

        if (state.sseScript && method === 'GET' && /\/stream$/.test(url)) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          for (const frame of state.sseScript) {
            res.write(frame);
          }
          stopStream = (): void => {
            try {
              res.end();
            } catch {
              // already closed
            }
          };
          state.stopStream = stopStream;
          return;
        }

        res.writeHead(state.intentResponse.status, state.intentResponse.headers);
        res.end(state.intentResponse.body);
      });
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind fake bridge');
  }
  state.port = addr.port;
  state.stop = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

async function writeBridgeStateFile(
  userDataDir: string,
  bridge: FakeBridge,
): Promise<void> {
  const dir = path.join(userDataDir, 'mcp', 'rebel-app-bridge');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({
      port: bridge.port,
      pid: process.pid,
      protocolVersion: '1.0',
      startedAt: bridge.startedAt,
      routerToken: bridge.routerToken,
      appTokens: [],
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// Proxy request helper — issues HTTPS requests against the sidecar,
// returning status + raw body.
// ---------------------------------------------------------------------------

async function proxyRequest(
  sidecar: OfficeSidecar,
  opts: {
    method: string;
    path: string;
    bearer?: string | null;
    body?: string;
    contentType?: string;
    accept?: string;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const https = await import('node:https');
  return await new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
    if (opts.accept) headers['Accept'] = opts.accept;
    if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body).toString();

    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: sidecar.port,
        path: opts.path,
        method: opts.method,
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sidecars: OfficeSidecar[] = [];
const bridges: FakeBridge[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (sidecars.length > 0) {
    const s = sidecars.pop();
    if (s) await s.stop().catch(() => undefined);
  }
  while (bridges.length > 0) {
    const b = bridges.pop();
    if (b) {
      try {
        b.stopStream();
      } catch {
        // ignore
      }
      await b.stop().catch(() => undefined);
    }
  }
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
  __resetBridgeAuthCacheForTests();
});

beforeEach(() => {
  __resetBridgeAuthCacheForTests();
});

async function setupWithBridge(): Promise<{
  sidecar: OfficeSidecar;
  sidecarToken: string;
  bridge: FakeBridge;
  userDataDir: string;
}> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-proxy-test-'));
  dirs.push(userDataDir);
  const sidecarStateDir = path.join(userDataDir, 'mcp', 'rebeloffice');
  await fs.mkdir(sidecarStateDir, { recursive: true });

  const bridge = await startFakeBridge();
  bridges.push(bridge);
  await writeBridgeStateFile(userDataDir, bridge);

  const addinDir = path.join(__dirname, '..', 'dist', 'addin');
  const sidecar = await startOfficeSidecar({
    stateDirectory: sidecarStateDir,
    port: 0,
    installToWefFolders: false,
    addinDir,
  });
  sidecars.push(sidecar);

  return { sidecar, sidecarToken: sidecar.token, bridge, userDataDir };
}

async function setupWithoutBridge(): Promise<{
  sidecar: OfficeSidecar;
  sidecarToken: string;
}> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-proxy-test-'));
  dirs.push(userDataDir);
  const sidecarStateDir = path.join(userDataDir, 'mcp', 'rebeloffice');
  await fs.mkdir(sidecarStateDir, { recursive: true });

  // Intentionally: NO bridge state file → ensureBridgeAuth returns null.
  const addinDir = path.join(__dirname, '..', 'dist', 'addin');
  const sidecar = await startOfficeSidecar({
    stateDirectory: sidecarStateDir,
    port: 0,
    installToWefFolders: false,
    addinDir,
  });
  sidecars.push(sidecar);

  return { sidecar, sidecarToken: sidecar.token };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('office sidecar — /intent/* proxy', () => {
  it('401s when no sidecar Bearer token is presented', async () => {
    const { sidecar } = await setupWithBridge();

    const res = await proxyRequest(sidecar, {
      method: 'GET',
      path: '/intent/health',
    });

    expect(res.status).toBe(401);
  });

  it('401s when the sidecar Bearer token is wrong', async () => {
    const { sidecar } = await setupWithBridge();

    const res = await proxyRequest(sidecar, {
      method: 'GET',
      path: '/intent/health',
      bearer: 'not-the-right-token',
    });

    expect(res.status).toBe(401);
  });

  it('503s when the App Bridge is not reachable', async () => {
    const { sidecar, sidecarToken } = await setupWithoutBridge();

    const res = await proxyRequest(sidecar, {
      method: 'GET',
      path: '/intent/health',
      bearer: sidecarToken,
    });

    expect(res.status).toBe(503);
    const parsed = JSON.parse(res.body) as { success: boolean; code: string };
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe('BRIDGE_NOT_READY');
  });

  it('proxies a GET /intent/health to the bridge and echoes the response', async () => {
    const { sidecar, sidecarToken, bridge } = await setupWithBridge();
    bridge.intentResponse = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, service: 'rebel-app-bridge' }),
    };

    const res = await proxyRequest(sidecar, {
      method: 'GET',
      path: '/intent/health',
      bearer: sidecarToken,
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    expect(bridge.lastIntentRequest?.method).toBe('GET');
    expect(bridge.lastIntentRequest?.path).toBe('/intent/health');
    expect(bridge.lastIntentRequest?.headers['authorization']).toBe(
      'Bearer paired-token-1',
    );
    expect(bridge.lastIntentRequest?.headers['x-rebel-app-id']).toBe('office-addin');
    expect(typeof bridge.lastIntentRequest?.headers['x-rebel-client-id']).toBe('string');
  });

  it('forwards X-Rebel-Diag-Id to the bridge for request correlation', async () => {
    const { sidecar, sidecarToken, bridge } = await setupWithBridge();
    bridge.intentResponse = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, service: 'rebel-app-bridge' }),
    };

    const requestId = '3f2783e3-4f8f-4d45-bb78-8f10ab9adf44';
    const res = await proxyRequest(sidecar, {
      method: 'GET',
      path: '/intent/health',
      bearer: sidecarToken,
      headers: {
        'X-Rebel-Diag-Id': requestId,
      },
    });

    expect(res.status).toBe(200);
    expect(bridge.lastIntentRequest?.headers['x-rebel-diag-id']).toBe(requestId);
  });

  it('stamps appId + clientId into POST /intent/conversation/create body', async () => {
    const { sidecar, sidecarToken, bridge } = await setupWithBridge();
    bridge.intentResponse = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, conversationId: 'conv-42', state: 'new' }),
    };

    const res = await proxyRequest(sidecar, {
      method: 'POST',
      path: '/intent/conversation/create',
      bearer: sidecarToken,
      contentType: 'application/json',
      body: JSON.stringify({
        intent: 'chat',
        documentContext: { host: 'word', title: 'Quarterly Plan.docx' },
      }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, conversationId: 'conv-42' });

    const forwarded = JSON.parse(bridge.lastIntentRequest?.body ?? '{}') as Record<
      string,
      unknown
    >;
    expect(forwarded.appId).toBe('office-addin');
    expect(typeof forwarded.clientId).toBe('string');
    expect((forwarded.clientId as string).length).toBeGreaterThan(0);
    expect(forwarded.intent).toBe('chat');
    expect(forwarded.documentContext).toMatchObject({
      host: 'word',
      title: 'Quarterly Plan.docx',
    });
  });

  it('404s for a path outside the /intent/* allowlist', async () => {
    const { sidecar, sidecarToken } = await setupWithBridge();

    const res = await proxyRequest(sidecar, {
      method: 'GET',
      path: '/intent/admin/reset',
      bearer: sidecarToken,
    });

    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body) as { code: string };
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('405s for unsupported methods on an allowed path', async () => {
    const { sidecar, sidecarToken } = await setupWithBridge();

    const res = await proxyRequest(sidecar, {
      method: 'DELETE',
      path: '/intent/conversation/xyz/messages',
      bearer: sidecarToken,
    });

    expect(res.status).toBe(405);
    const parsed = JSON.parse(res.body) as { code: string };
    expect(parsed.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('passes through an SSE stream on /intent/conversation/:id/stream', async () => {
    const { sidecar, sidecarToken, bridge } = await setupWithBridge();
    bridge.sseScript = [
      'event: connected\ndata: {"conversationId":"c1","turnStatus":"idle"}\n\n',
      'event: assistant_delta\ndata: {"turnId":"t1","text":"hello"}\n\n',
    ];

    const https = await import('node:https');
    const received = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = https.request(
          {
            hostname: '127.0.0.1',
            port: sidecar.port,
            path: '/intent/conversation/c1/stream',
            method: 'GET',
            headers: {
              Authorization: `Bearer ${sidecarToken}`,
              Accept: 'text/event-stream',
            },
            rejectUnauthorized: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => {
              chunks.push(c);
              if (Buffer.concat(chunks).toString('utf8').includes('"text":"hello"')) {
                // We've observed both frames — end the stream.
                bridge.stopStream();
              }
            });
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end();
      },
    );

    expect(received.status).toBe(200);
    expect(received.body).toContain('event: connected');
    expect(received.body).toContain('"conversationId":"c1"');
    expect(received.body).toContain('event: assistant_delta');
    expect(received.body).toContain('"text":"hello"');
  });

  it('reuses the minted bridge token across multiple /intent/* calls', async () => {
    const { sidecar, sidecarToken, bridge } = await setupWithBridge();
    bridge.intentResponse = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, service: 'rebel-app-bridge' }),
    };

    const first = await proxyRequest(sidecar, {
      method: 'GET',
      path: '/intent/health',
      bearer: sidecarToken,
    });
    const second = await proxyRequest(sidecar, {
      method: 'GET',
      path: '/intent/health',
      bearer: sidecarToken,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(bridge.mintCallCount).toBe(1);
    expect(bridge.intentRequests).toHaveLength(2);
    expect(
      bridge.intentRequests.map((request) => request.headers['authorization']),
    ).toEqual(['Bearer paired-token-1', 'Bearer paired-token-1']);
  });

  it('invalidates the cached bridge token when the bridge returns 401, and re-mints on the next /intent/* call', async () => {
    const { sidecar, sidecarToken, bridge } = await setupWithBridge();
    bridge.intentResponse = {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, code: 'UNAUTHORIZED' }),
    };

    const unauthorized = await proxyRequest(sidecar, {
      method: 'GET',
      path: '/intent/health',
      bearer: sidecarToken,
    });
    bridge.intentResponse = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, service: 'rebel-app-bridge' }),
    };
    const recovered = await proxyRequest(sidecar, {
      method: 'GET',
      path: '/intent/health',
      bearer: sidecarToken,
    });

    expect(unauthorized.status).toBe(401);
    expect(recovered.status).toBe(200);
    expect(bridge.mintCallCount).toBe(2);
    expect(
      bridge.intentRequests.map((request) => request.headers['authorization']),
    ).toEqual(['Bearer paired-token-1', 'Bearer paired-token-2']);
  });

  it('invalidates the cached bridge token when an SSE response contains a revoked event', async () => {
    const { sidecar, sidecarToken, bridge } = await setupWithBridge();
    bridge.sseScript = ['event: revoked\ndata: {"reason":"pairing_revoked"}\n\n'];

    const https = await import('node:https');
    const revoked = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = https.request(
          {
            hostname: '127.0.0.1',
            port: sidecar.port,
            path: '/intent/conversation/c1/stream',
            method: 'GET',
            headers: {
              Authorization: `Bearer ${sidecarToken}`,
              Accept: 'text/event-stream',
            },
            rejectUnauthorized: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => {
              chunks.push(c);
              if (Buffer.concat(chunks).toString('utf8').includes('event: revoked')) {
                bridge.stopStream();
              }
            });
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end();
      },
    );

    bridge.intentResponse = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, service: 'rebel-app-bridge' }),
    };
    const recovered = await proxyRequest(sidecar, {
      method: 'GET',
      path: '/intent/health',
      bearer: sidecarToken,
    });

    expect(revoked.status).toBe(200);
    expect(revoked.body).toContain('event: revoked');
    expect(recovered.status).toBe(200);
    expect(bridge.mintCallCount).toBe(2);
    expect(
      bridge.intentRequests.map((request) => request.headers['authorization']),
    ).toEqual(['Bearer paired-token-1', 'Bearer paired-token-2']);
  });
});
