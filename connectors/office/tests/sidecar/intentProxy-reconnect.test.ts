import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createIntentClient } from '../../src/shared/intentClient/client.js';
import type { ConnectStreamError } from '../../src/shared/intentClient/clientTypes.js';
import type { StreamCloseReason } from '../../src/shared/intentClient/diagnostics.js';
import type { IntentTransportAdapter } from '../../src/shared/intentClient/intentTransportAdapter.js';
import {
  __resetBridgeAuthCacheForTests,
  startOfficeSidecar,
  type OfficeSidecar,
} from '../../src/sidecar/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface StreamScriptStep {
  delayMs: number;
  frame: string;
}

interface FakeBridgeOptions {
  mode: 'close-after-events' | 'stall-after-open';
  steps?: StreamScriptStep[];
}

interface FakeBridge {
  port: number;
  routerToken: string;
  startedAt: string;
  mintCallCount: number;
  stop: () => Promise<void>;
}

async function startFakeBridge(options: FakeBridgeOptions): Promise<FakeBridge> {
  const sockets = new Set<net.Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const state: FakeBridge = {
    port: 0,
    routerToken: `router-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: new Date().toISOString(),
    mintCallCount: 0,
    stop: async () => undefined,
  };

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'POST' && url === '/host/mint-app-token') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${state.routerToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        state.mintCallCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            token: `paired-token-${state.mintCallCount}`,
          }),
        );
      });
      return;
    }

    if (method === 'POST' && url === '/intent/conversation/stream') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >;
        if (parsedBody.conversationId !== 'conv-reconnect') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'unexpected conversation id' }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        if (options.mode === 'stall-after-open') {
          res.write('event: connected\ndata: {"conversationId":"conv-reconnect","turnStatus":"idle"}\n\n');
          // Intentionally never close the socket and never write further bytes.
          return;
        }

        const steps =
          options.steps ??
          [
            {
              delayMs: 5,
              frame:
                'event: connected\ndata: {"conversationId":"conv-reconnect","turnStatus":"idle"}\n\n',
            },
            {
              delayMs: 5,
              frame:
                'event: assistant_delta\ndata: {"turnId":"turn-1","text":"hello"}\n\n',
            },
          ];

        let index = 0;
        const runNext = (): void => {
          if (index >= steps.length) {
            res.end();
            return;
          }
          const step = steps[index]!;
          const timer = setTimeout(() => {
            timers.delete(timer);
            res.write(step.frame);
            index += 1;
            runNext();
          }, step.delayMs);
          timers.add(timer);
        };
        runNext();
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: 'not found' }));
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind fake bridge');
  }
  state.port = address.port;

  state.stop = async () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return state;
}

async function writeBridgeStateFile(
  userDataDir: string,
  bridge: FakeBridge,
): Promise<void> {
  const bridgeStateDir = path.join(userDataDir, 'mcp', 'rebel-app-bridge');
  await fs.mkdir(bridgeStateDir, { recursive: true });
  await fs.writeFile(
    path.join(bridgeStateDir, 'state.json'),
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

function createSidecarTransport(sidecar: OfficeSidecar): IntentTransportAdapter {
  const baseUrl = `https://127.0.0.1:${sidecar.port}`;
  return {
    resolveBaseUrl: () => baseUrl,
    buildHeaders: async (init) => {
      const headers = new Headers();
      headers.set('authorization', `Bearer ${sidecar.token}`);
      if (init.contentType) {
        headers.set('content-type', init.contentType);
      }
      if (init.accept) {
        headers.set('accept', init.accept);
      }
      return headers;
    },
    describeForLog: () => ({
      surface: 'office-addin',
      origin: baseUrl,
      transportKind: 'sidecar-proxy',
    }),
  };
}

function createInsecureFetch(): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const requestHeaders = new Headers(init?.headers);

    return await new Promise<Response>((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(requestHeaders.entries()),
          rejectUnauthorized: false,
        },
        (res) => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              responseHeaders.set(key, value.join(', '));
            } else if (value !== undefined) {
              responseHeaders.set(key, value);
            }
          }
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
              res.on('end', () => controller.close());
              res.on('error', (error) => controller.error(error));
            },
          });
          resolve(
            new Response(stream, {
              status: res.statusCode ?? 0,
              headers: responseHeaders,
            }),
          );
        },
      );
      req.on('error', reject);
      if (typeof init?.body === 'string' || init?.body instanceof Uint8Array) {
        req.write(init.body);
      }
      req.end();
    });
  };
}

async function readDiagTail(sidecar: OfficeSidecar): Promise<{ lines: string[]; capturedAt: string }> {
  const https = await import('node:https');
  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: sidecar.port,
        path: '/diag/tail',
        method: 'GET',
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              lines?: string[];
              capturedAt?: string;
            };
            resolve({
              lines: parsed.lines ?? [],
              capturedAt: parsed.capturedAt ?? '',
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs),
    ),
  ]);
}

const sidecars: OfficeSidecar[] = [];
const bridges: FakeBridge[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (sidecars.length > 0) {
    const sidecar = sidecars.pop();
    if (sidecar) {
      await sidecar.stop().catch(() => undefined);
    }
  }
  while (bridges.length > 0) {
    const bridge = bridges.pop();
    if (bridge) {
      await bridge.stop().catch(() => undefined);
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  __resetBridgeAuthCacheForTests();
});

async function setup(options: {
  bridge: FakeBridgeOptions;
  intentProxyStreamReadTimeoutMs?: number;
}): Promise<{ sidecar: OfficeSidecar; bridge: FakeBridge }> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-reconnect-test-'));
  dirs.push(userDataDir);
  const sidecarStateDir = path.join(userDataDir, 'mcp', 'rebeloffice');
  await fs.mkdir(sidecarStateDir, { recursive: true });

  const bridge = await startFakeBridge(options.bridge);
  bridges.push(bridge);
  await writeBridgeStateFile(userDataDir, bridge);

  const addinDir = path.join(__dirname, '..', '..', 'dist', 'addin');
  const sidecar = await startOfficeSidecar({
    stateDirectory: sidecarStateDir,
    addinDir,
    port: 0,
    installToWefFolders: false,
    ...(options.intentProxyStreamReadTimeoutMs === undefined
      ? {}
      : { intentProxyStreamReadTimeoutMs: options.intentProxyStreamReadTimeoutMs }),
  });
  sidecars.push(sidecar);

  return { sidecar, bridge };
}

describe('intent proxy reconnect spike (shared client through sidecar)', () => {
  it("propagates upstream close to shared client onClose('eof')", async () => {
    const { sidecar } = await setup({
      bridge: { mode: 'close-after-events' },
    });
    const client = createIntentClient({
      transport: createSidecarTransport(sidecar),
      fetchImpl: createInsecureFetch(),
    });

    const observedEventKinds: string[] = [];
    const closeReason = await withTimeout(
      new Promise<StreamCloseReason>((resolve, reject) => {
        client.connectStream(
          { conversationId: 'conv-reconnect' },
          {
            onEvent: (event) => {
              observedEventKinds.push(event.type);
            },
            onError: (error: ConnectStreamError) => {
              reject(
                new Error(
                  `Unexpected onError during EOF-close spike: ${
                    error instanceof Error ? error.message : JSON.stringify(error)
                  }`,
                ),
              );
            },
            onClose: resolve,
          },
        );
      }),
      3_000,
      'Timed out waiting for connectStream onClose callback',
    );

    expect(closeReason).toBe('eof');
    expect(observedEventKinds).toContain('connected');
    expect(observedEventKinds).toContain('assistant_delta');
  });

  it('fires onError + close(error) when proxy stream read-timeout trips on stalled upstream', async () => {
    const { sidecar } = await setup({
      bridge: { mode: 'stall-after-open' },
      intentProxyStreamReadTimeoutMs: 75,
    });
    const client = createIntentClient({
      transport: createSidecarTransport(sidecar),
      fetchImpl: createInsecureFetch(),
    });

    const streamErrors: ConnectStreamError[] = [];
    const closeReason = await withTimeout(
      new Promise<StreamCloseReason>((resolve) => {
        client.connectStream(
          { conversationId: 'conv-reconnect' },
          {
            onEvent: () => undefined,
            onError: (error) => {
              streamErrors.push(error);
            },
            onClose: resolve,
          },
        );
      }),
      3_000,
      'Timed out waiting for read-timeout close path',
    );

    expect(closeReason).toBe('error');
    expect(streamErrors.length).toBeGreaterThan(0);

    const tail = await readDiagTail(sidecar);
    expect(
      tail.lines.some((line) => line.includes('[sidecar-proxy] upstream-timeout')),
    ).toBe(true);
    expect(
      tail.lines.some(
        (line) =>
          line.startsWith('[sidecar-proxy]') && /requestId=[^\s]+/.test(line),
      ),
    ).toBe(true);
  });
});
