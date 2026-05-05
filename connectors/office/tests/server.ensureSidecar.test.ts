import fs from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { getHttpsServerOptions } from 'office-addin-dev-certs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type EnsureSidecarTestHooks = {
  ensureSidecar: () => Promise<{
    port: number;
    token: string;
    pid: number;
    lastEagerStartErrorCode?: string;
  } | null | undefined>;
  setSpawnSidecarAndWaitForTests: (fn: () => Promise<void>) => void;
  setBeforeLockedStateCheckForTests: (fn: () => Promise<void> | void) => void;
  resetForTests: () => void;
};

type FallbackReason =
  | 'no-state-file'
  | 'pid-dead'
  | 'same-process-stale-pid'
  | 'health-timeout'
  | 'health-non-200'
  | 'pid-dead-under-lock';

type FallbackSentinel = {
  event: string;
  reason: FallbackReason;
  lastEagerStartErrorCode: string | null;
  pid: number;
  at: number;
};

type HealthServer = {
  port: number;
  close: () => Promise<void>;
};

let stateDir = '';
let stateFilePath = '';
let lastFailureFilePath = '';
let hooks: EnsureSidecarTestHooks;

const cleanupChildren = new Set<ChildProcess>();
const cleanupServers = new Set<HealthServer>();

async function writeStateFile(state: {
  port: number;
  token: string;
  pid: number;
  lastEagerStartErrorCode?: string;
}): Promise<void> {
  await fs.writeFile(stateFilePath, JSON.stringify(state), 'utf8');
}

async function writeLastFailureFile(lastFailure: {
  code: string;
  at?: number;
}): Promise<void> {
  await fs.writeFile(lastFailureFilePath, JSON.stringify({
    code: lastFailure.code,
    at: lastFailure.at ?? Date.now(),
  }), 'utf8');
}

async function startLivePid(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000);'], {
    stdio: 'ignore',
  });
  cleanupChildren.add(child);
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    cleanupChildren.delete(child);
    return;
  }

  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 250);
  });
  cleanupChildren.delete(child);
}

async function startHealthServer(
  handler: Parameters<typeof https.createServer>[1],
): Promise<HealthServer> {
  const sockets = new Set<import('node:net').Socket>();
  const httpsOptions = await getHttpsServerOptions();
  const server = https.createServer(httpsOptions, handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine health server port.');
  }

  const wrapped: HealthServer = {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
  cleanupServers.add(wrapped);
  return wrapped;
}

async function captureStderr(run: () => Promise<void>): Promise<string> {
  let output = '';
  const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...args: unknown[]) => {
    output += typeof chunk === 'string' ? chunk : chunk.toString();
    const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === 'function');
    callback?.(null);
    return true;
  }) as never);

  try {
    await run();
    return output;
  } finally {
    writeSpy.mockRestore();
  }
}

async function captureFallbackSentinel(run: () => Promise<unknown>): Promise<FallbackSentinel> {
  const stderr = await captureStderr(async () => {
    await run();
  });
  const lines = stderr
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('Expected fallback sentinel on stderr.');
  }

  return JSON.parse(lines.at(-1)!) as FallbackSentinel;
}

beforeAll(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-server-ensure-sidecar-'));
  stateFilePath = path.join(stateDir, 'sidecar-state.json');
  lastFailureFilePath = path.join(stateDir, 'sidecar-last-failure.json');
  process.env.MCP_OFFICE_SIDECAR_STATE = stateFilePath;
  const serverModule = (await import('../src/index.js')) as unknown as {
    __test: EnsureSidecarTestHooks;
  };
  hooks = serverModule.__test;
});

beforeEach(async () => {
  delete process.env.MCP_OFFICE_SIDECAR_DISABLE;
  hooks.resetForTests();
  await fs.mkdir(stateDir, { recursive: true });
});

afterEach(async () => {
  for (const server of Array.from(cleanupServers)) {
    await server.close();
    cleanupServers.delete(server);
  }

  for (const child of Array.from(cleanupChildren)) {
    await stopChild(child);
  }

  hooks.resetForTests();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe('server.cjs ensureSidecar', () => {
  it('returns the existing state without spawning when /health returns 200', async () => {
    const livePid = await startLivePid();
    const healthServer = await startHealthServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const spawnSpy = vi.fn(async () => {});

    await writeStateFile({
      port: healthServer.port,
      token: 'existing-token',
      pid: livePid.pid!,
    });
    hooks.setSpawnSidecarAndWaitForTests(spawnSpy);

    const state = await hooks.ensureSidecar();

    expect(state).toMatchObject({
      port: healthServer.port,
      token: 'existing-token',
      pid: livePid.pid,
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('writes a no-state-file fallback sentinel when no eager-start state exists', async () => {
    const spawnSpy = vi.fn(async () => {});
    hooks.setSpawnSidecarAndWaitForTests(spawnSpy);

    const sentinel = await captureFallbackSentinel(() => hooks.ensureSidecar());

    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(sentinel.reason).toBe('no-state-file');
    expect(sentinel.lastEagerStartErrorCode).toBeNull();
  });

  it('reads sidecar-last-failure.json when the state file is missing', async () => {
    const spawnSpy = vi.fn(async () => {});
    hooks.setSpawnSidecarAndWaitForTests(spawnSpy);
    await writeLastFailureFile({ code: 'port-in-use' });

    const sentinel = await captureFallbackSentinel(() => hooks.ensureSidecar());

    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(sentinel.reason).toBe('no-state-file');
    expect(sentinel.lastEagerStartErrorCode).toBe('port-in-use');
  });

  it('logs malformed sidecar-last-failure.json reads before falling back', async () => {
    const spawnSpy = vi.fn(async () => {});
    hooks.setSpawnSidecarAndWaitForTests(spawnSpy);
    await fs.writeFile(lastFailureFilePath, '{"code":', 'utf8');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const sentinel = await captureFallbackSentinel(() => hooks.ensureSidecar());

    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(sentinel.reason).toBe('no-state-file');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[office-sidecar] failed to read sidecar-last-failure.json',
      expect.any(String),
    );
  });

  it('writes a health-timeout fallback sentinel when /health times out', async () => {
    const livePid = await startLivePid();
    const healthServer = await startHealthServer((req) => {
      if (req.url === '/health') {
        // Leave the socket hanging so the 2 s timeout path is exercised.
      }
    });
    const spawnSpy = vi.fn(async () => {});

    await writeStateFile({
      port: healthServer.port,
      token: 'timeout-token',
      pid: livePid.pid!,
    });
    hooks.setSpawnSidecarAndWaitForTests(spawnSpy);

    const sentinel = await captureFallbackSentinel(() => hooks.ensureSidecar());

    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(sentinel.reason).toBe('health-timeout');
  });

  it('writes a health-non-200 fallback sentinel when /health returns 500', async () => {
    const livePid = await startLivePid();
    const healthServer = await startHealthServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"status":"nope"}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const spawnSpy = vi.fn(async () => {});

    await writeStateFile({
      port: healthServer.port,
      token: 'broken-token',
      pid: livePid.pid!,
    });
    hooks.setSpawnSidecarAndWaitForTests(spawnSpy);

    const sentinel = await captureFallbackSentinel(() => hooks.ensureSidecar());

    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(sentinel.reason).toBe('health-non-200');
  });

  it('throws a brand-voice kill-switch error without leaking the env var name', async () => {
    const spawnSpy = vi.fn(async () => {});
    hooks.setSpawnSidecarAndWaitForTests(spawnSpy);
    process.env.MCP_OFFICE_SIDECAR_DISABLE = '1';

    const error = await hooks.ensureSidecar().then(
      () => {
        throw new Error('Expected MCP_OFFICE_SIDECAR_DISABLE to reject ensureSidecar().');
      },
      (caught) => caught as Error & { code?: string },
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('The Office connection has been turned off for this Rebel installation.');
    expect(error.message).not.toContain('MCP_OFFICE_SIDECAR_DISABLE');
    expect(error.message.toLowerCase()).not.toContain('env variable');
    expect(error.code).toBe('kill-switch');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('honors the legacy REBEL_DISABLE_OFFICE_SIDECAR kill-switch for backward compat', async () => {
    const spawnSpy = vi.fn(async () => {});
    hooks.setSpawnSidecarAndWaitForTests(spawnSpy);
    process.env.REBEL_DISABLE_OFFICE_SIDECAR = '1';

    const error = await hooks.ensureSidecar().then(
      () => {
        throw new Error('Expected legacy kill-switch to reject ensureSidecar().');
      },
      (caught) => caught as Error & { code?: string },
    );

    expect(error.code).toBe('kill-switch');
    expect(error.message).not.toContain('REBEL_DISABLE_OFFICE_SIDECAR');
    expect(error.message).not.toContain('MCP_OFFICE_SIDECAR_DISABLE');
    expect(spawnSpy).not.toHaveBeenCalled();

    delete process.env.REBEL_DISABLE_OFFICE_SIDECAR;
  });

  it('writes a pid-dead fallback sentinel with lastEagerStartErrorCode when spawning lazily', async () => {
    const spawnSpy = vi.fn(async () => {});
    hooks.setSpawnSidecarAndWaitForTests(spawnSpy);
    await writeStateFile({
      port: 52_100,
      token: 'stale-token',
      pid: 999_999,
      lastEagerStartErrorCode: 'port-in-use',
    });

    const sentinel = await captureFallbackSentinel(() => hooks.ensureSidecar());

    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(sentinel.event).toBe('office-sidecar.fallback-invoked');
    expect(sentinel.reason).toBe('pid-dead');
    expect(sentinel.lastEagerStartErrorCode).toBe('port-in-use');
    expect(sentinel.pid).toBe(process.pid);
    expect(sentinel.at).toBeTypeOf('number');
  });

  it('writes a same-process-stale-pid fallback sentinel when the state points at the MCP process', async () => {
    const spawnSpy = vi.fn(async () => {});
    hooks.setSpawnSidecarAndWaitForTests(spawnSpy);
    await writeStateFile({
      port: 52_100,
      token: 'same-process-token',
      pid: process.pid,
    });

    const sentinel = await captureFallbackSentinel(() => hooks.ensureSidecar());

    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(sentinel.reason).toBe('same-process-stale-pid');
  });

  it('writes a pid-dead-under-lock fallback sentinel when the under-lock recheck finds a dead pid', async () => {
    const spawnSpy = vi.fn(async () => {});
    hooks.setSpawnSidecarAndWaitForTests(spawnSpy);
    hooks.setBeforeLockedStateCheckForTests(async () => {
      await writeStateFile({
        port: 52_100,
        token: 'under-lock-dead-pid',
        pid: 999_999,
      });
    });

    const sentinel = await captureFallbackSentinel(() => hooks.ensureSidecar());

    expect(spawnSpy).toHaveBeenCalledOnce();
    expect(sentinel.reason).toBe('pid-dead-under-lock');
  });
});
