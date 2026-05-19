/**
 * Integration tests for the Office sidecar's "auto-mint paired app token"
 * flow.
 *
 * The sidecar sits alongside the App Bridge inside Rebel's trust boundary
 * (same user, same machine, can read the bridge's 0o600 state file). On
 * taskpane.html serve, it:
 *   1. Reads `<userData>/mcp/rebel-app-bridge/state.json` to discover the
 *      bridge port + router-internal token.
 *   2. Loads/generates a stable `clientId` persisted under its own state
 *      directory so restarts don't churn token-store entries.
 *   3. Calls `POST /host/mint-app-token` on the bridge with the router
 *      token as `Authorization: Bearer` — the bridge returns a paired
 *      app token scoped to `('office-addin', <clientId>)`.
 *   4. Caches the `(port, startedAt, token, clientId)` in memory so
 *      subsequent taskpane serves don't re-mint unless the bridge
 *      restarts (port/startedAt change).
 *   5. Injects `{ bridgeReady: true | false }` into
 *      `window.__REBEL_SIDECAR_CONFIG`; the paired token and clientId
 *      stay server-side (the task-pane reaches the bridge only via the
 *      sidecar's `/intent/*` proxy). See
 *      `docs/plans/260423_office_addin_intent_proxy.md`.
 *
 * These tests spin up a fake bridge on a random port, fake its state file
 * on disk, and drive the sidecar's taskpane-HTML endpoint to observe the
 * mint cache behaviour (`bridgeReady` + `fakeBridge.mintCallCount`).
 */

import http from 'node:http';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startOfficeSidecar, type OfficeSidecar, __resetBridgeAuthCacheForTests } from '../src/sidecar/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fake bridge — just the `/host/mint-app-token` endpoint we care about
// ---------------------------------------------------------------------------

interface FakeBridge {
  port: number;
  routerToken: string;
  startedAt: string;
  /** Number of mint calls the fake bridge has received. */
  mintCallCount: number;
  /** Last received mint body — for assertions. */
  lastMintBody: { appId: string; clientId: string } | null;
  /** Close the fake bridge and clean up. */
  stop: () => Promise<void>;
  /** Override: next mint request will fail with this status. Cleared after use. */
  failNextMintWith: number | null;
  /** Swap out the routerToken to simulate a bridge restart. */
  setRouterToken: (next: string) => void;
  /** Update `startedAt` to simulate a restart without changing the port. */
  setStartedAt: (next: string) => void;
}

async function startFakeBridge(): Promise<FakeBridge> {
  const state: FakeBridge = {
    port: 0,
    routerToken: `fake-router-token-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: new Date().toISOString(),
    mintCallCount: 0,
    lastMintBody: null,
    failNextMintWith: null,
    stop: async () => undefined,
    setRouterToken: (next) => {
      state.routerToken = next;
    },
    setStartedAt: (next) => {
      state.startedAt = next;
    },
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/host/mint-app-token') {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${state.routerToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason: 'unauthorized' }));
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          appId: string;
          clientId: string;
        };
        state.mintCallCount += 1;
        state.lastMintBody = { appId: body.appId, clientId: body.clientId };

        if (state.failNextMintWith !== null) {
          const status = state.failNextMintWith;
          state.failNextMintWith = null;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: 'forced-failure' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            token: `fake-paired-token-call-${state.mintCallCount}`,
            appId: body.appId,
            clientId: body.clientId,
          }),
        );
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return state;
}

// ---------------------------------------------------------------------------
// State file helpers — mirror the shape `src/core/appBridge/server/bridge.ts`
// writes, minus the token-claims array (unused by the sidecar reader).
// ---------------------------------------------------------------------------

async function writeBridgeStateFile(
  userDataDir: string,
  bridge: FakeBridge,
): Promise<string> {
  const bridgeStateDir = path.join(userDataDir, 'mcp', 'rebel-app-bridge');
  await fs.mkdir(bridgeStateDir, { recursive: true });
  const stateFile = path.join(bridgeStateDir, 'state.json');
  await fs.writeFile(
    stateFile,
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
  return stateFile;
}

async function readTaskpaneHtmlConfig(
  sidecar: OfficeSidecar,
): Promise<Record<string, unknown> | null> {
  const https = await import('node:https');
  const html = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: sidecar.port,
        path: '/taskpane.html',
        method: 'GET',
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.end();
  });

  const match = /window\.__REBEL_SIDECAR_CONFIG\s*=\s*(\{[^<]*?\})\s*;/.exec(html);
  if (!match || !match[1]) return null;
  return JSON.parse(match[1]) as Record<string, unknown>;
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
    if (b) await b.stop().catch(() => undefined);
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

async function setup(): Promise<{
  sidecar: OfficeSidecar;
  bridge: FakeBridge;
  userDataDir: string;
  sidecarStateDir: string;
}> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-auth-test-'));
  dirs.push(userDataDir);
  const sidecarStateDir = path.join(userDataDir, 'mcp', 'rebeloffice');
  await fs.mkdir(sidecarStateDir, { recursive: true });

  const bridge = await startFakeBridge();
  bridges.push(bridge);
  await writeBridgeStateFile(userDataDir, bridge);

  // We don't need a real addinDir — the sidecar's taskpane.html serve
  // uses the built file, which exists under dist/addin after npm run build.
  const addinDir = path.join(__dirname, '..', 'dist', 'addin');

  const sidecar = await startOfficeSidecar({
    stateDirectory: sidecarStateDir,
    port: 0,
    installToWefFolders: false,
    addinDir,
  });
  sidecars.push(sidecar);

  return { sidecar, bridge, userDataDir, sidecarStateDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('office sidecar — bridge auth wiring', () => {
  it('mints a paired app token on first taskpane HTML request', async () => {
    const { sidecar, bridge } = await setup();

    const config = await readTaskpaneHtmlConfig(sidecar);
    expect(config).not.toBeNull();
    expect(config?.bridgeReady).toBe(true);
    expect(bridge.mintCallCount).toBe(1);
    expect(bridge.lastMintBody?.appId).toBe('office-addin');
    expect(typeof bridge.lastMintBody?.clientId).toBe('string');
    expect((bridge.lastMintBody?.clientId as string).length).toBeGreaterThan(0);
  });

  it('caches the token across subsequent HTML requests (no re-mint)', async () => {
    const { sidecar, bridge } = await setup();

    const first = await readTaskpaneHtmlConfig(sidecar);
    const second = await readTaskpaneHtmlConfig(sidecar);
    const third = await readTaskpaneHtmlConfig(sidecar);

    expect(first?.bridgeReady).toBe(true);
    expect(second?.bridgeReady).toBe(true);
    expect(third?.bridgeReady).toBe(true);
    expect(bridge.mintCallCount).toBe(1);
  });

  it('re-mints when the bridge state file reports a different port', async () => {
    const { sidecar, bridge, userDataDir } = await setup();

    // First serve — cache populated.
    await readTaskpaneHtmlConfig(sidecar);
    expect(bridge.mintCallCount).toBe(1);

    // Simulate bridge restart on a different port: stop the fake bridge,
    // start a new one, rewrite the state file. The cache key is
    // `(port, startedAt)`, so the port change forces a re-mint.
    await bridge.stop();
    const bridge2 = await startFakeBridge();
    bridges.push(bridge2);
    await writeBridgeStateFile(userDataDir, bridge2);

    const configAfter = await readTaskpaneHtmlConfig(sidecar);
    expect(configAfter?.bridgeReady).toBe(true);
    expect(bridge2.mintCallCount).toBe(1);
  });

  it('re-mints when startedAt changes (bridge restart on same port)', async () => {
    const { sidecar, bridge, userDataDir } = await setup();

    await readTaskpaneHtmlConfig(sidecar);
    expect(bridge.mintCallCount).toBe(1);

    // Bump startedAt — the cache key invalidates and the sidecar mints again.
    bridge.setStartedAt(new Date(Date.now() + 1_000).toISOString());
    await writeBridgeStateFile(userDataDir, bridge);

    const configAfter = await readTaskpaneHtmlConfig(sidecar);
    expect(configAfter?.bridgeReady).toBe(true);
    expect(bridge.mintCallCount).toBe(2);
  });

  it('reports bridgeReady=false when the bridge state file is absent', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-auth-test-'));
    dirs.push(userDataDir);
    const sidecarStateDir = path.join(userDataDir, 'mcp', 'rebeloffice');
    await fs.mkdir(sidecarStateDir, { recursive: true });

    // Intentionally: NO bridge state file.
    const addinDir = path.join(__dirname, '..', 'dist', 'addin');
    const sidecar = await startOfficeSidecar({
      stateDirectory: sidecarStateDir,
      port: 0,
      installToWefFolders: false,
      addinDir,
    });
    sidecars.push(sidecar);

    const config = await readTaskpaneHtmlConfig(sidecar);
    expect(config).not.toBeNull();
    expect(config?.port).toBe(sidecar.port);
    expect(typeof config?.token).toBe('string');
    expect(config?.bridgeReady).toBe(false);
  });

  it('reports bridgeReady=false when the mint round-trip fails', async () => {
    const { sidecar, bridge } = await setup();
    bridge.failNextMintWith = 503;

    const config = await readTaskpaneHtmlConfig(sidecar);
    expect(config).not.toBeNull();
    expect(config?.bridgeReady).toBe(false);
    expect(bridge.mintCallCount).toBe(1);
  });

  it('recovers after a transient mint failure (no poisoned cache)', async () => {
    const { sidecar, bridge } = await setup();
    bridge.failNextMintWith = 503;

    const failing = await readTaskpaneHtmlConfig(sidecar);
    expect(failing?.bridgeReady).toBe(false);

    // Next request should retry (cache was invalidated on failure).
    const recovered = await readTaskpaneHtmlConfig(sidecar);
    expect(recovered?.bridgeReady).toBe(true);
    expect(bridge.mintCallCount).toBe(2);
  });

  it('persists the clientId across sidecar restarts', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-auth-test-'));
    dirs.push(userDataDir);
    const sidecarStateDir = path.join(userDataDir, 'mcp', 'rebeloffice');
    await fs.mkdir(sidecarStateDir, { recursive: true });

    const bridge = await startFakeBridge();
    bridges.push(bridge);
    await writeBridgeStateFile(userDataDir, bridge);

    const addinDir = path.join(__dirname, '..', 'dist', 'addin');

    // First sidecar — mints and persists the clientId.
    const sidecar1 = await startOfficeSidecar({
      stateDirectory: sidecarStateDir,
      port: 0,
      installToWefFolders: false,
      addinDir,
    });
    sidecars.push(sidecar1);
    await readTaskpaneHtmlConfig(sidecar1);
    const clientId1 = bridge.lastMintBody?.clientId as string;
    expect(typeof clientId1).toBe('string');
    expect(clientId1.length).toBeGreaterThan(0);
    await sidecar1.stop();
    sidecars.pop();

    // Drop the in-memory cache — second sidecar instance starts cold.
    __resetBridgeAuthCacheForTests();

    // Second sidecar — reads the same clientId from disk. The fake
    // bridge only sees it via the mint round-trip body.
    const sidecar2 = await startOfficeSidecar({
      stateDirectory: sidecarStateDir,
      port: 0,
      installToWefFolders: false,
      addinDir,
    });
    sidecars.push(sidecar2);
    await readTaskpaneHtmlConfig(sidecar2);
    expect(bridge.lastMintBody?.clientId).toBe(clientId1);
  });

  it('sends the router token as Bearer auth on mint requests', async () => {
    const { sidecar, bridge, userDataDir } = await setup();

    // Flip the router token the bridge recognizes to assert the sidecar
    // is actually reading it from the state file and sending it. Also
    // change `startedAt` so the cache invalidates (same port).
    bridge.setRouterToken('secret-new-router-token');
    bridge.setStartedAt(new Date(Date.now() + 2_000).toISOString());
    await writeBridgeStateFile(userDataDir, bridge);

    const config = await readTaskpaneHtmlConfig(sidecar);
    // If the sidecar had sent the old token, the fake bridge would 401
    // and `bridgeReady` would be false. Getting a true means the sidecar
    // read the new one from the state file.
    expect(config?.bridgeReady).toBe(true);
  });
});
