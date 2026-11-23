import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { setTimeout as realDelay } from 'node:timers/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { getHttpsServerOptions } from 'office-addin-dev-certs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sidecarSpawn = vi.hoisted(() => ({
  override: undefined as undefined | ((spawn: typeof import('node:child_process').spawn) => ChildProcess),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: ((...args: Parameters<typeof original.spawn>) => {
      const script = args[1]?.[0];
      if (typeof script === 'string' && /[\\/]sidecar[\\/]cli\.js$/.test(script) && sidecarSpawn.override) {
        return sidecarSpawn.override(original.spawn);
      }
      return original.spawn(...args);
    }) as typeof original.spawn,
  };
});

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
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    cleanupChildren.delete(child);
    return;
  }

  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 250);
    child.once('exit', () => clearTimeout(escalation));
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
  vi.useRealTimers();
  sidecarSpawn.override = undefined;
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

describe('defaultSpawnSidecarAndWait (real default)', () => {
  let child: ChildProcess | undefined;
  let spawnError: Error | undefined;
  let killSpy: ReturnType<typeof vi.spyOn>;

  async function observeExit(): Promise<void> {
    const deadline = Date.now() + 750;
    while (child!.exitCode === null && child!.signalCode === null && Date.now() < deadline) {
      await realDelay(10);
    }
  }

  function fixture(mode: 'ready' | 'silent' | 'exit' | 'missing', port?: number): void {
    sidecarSpawn.override = (realSpawn) => {
      child = mode === 'missing'
        ? realSpawn(path.join(stateDir, 'missing-node'), [], { stdio: 'pipe' })
        : realSpawn(process.execPath, ['-e', mode === 'exit'
          ? 'process.exit(3);'
          : `${mode === 'ready' ? 'process.stdout.write("{\\"ready\\":true}\\n");' : ''}setInterval(() => {}, 1_000);`], {
          stdio: 'pipe',
          detached: false,
        });
      cleanupChildren.add(child);
      killSpy = vi.spyOn(child, 'kill');
      child.once('error', (error) => { spawnError = error; });
      if (port !== undefined) {
        syncFs.writeFileSync(stateFilePath, JSON.stringify({ port, token: 'fixture-token', pid: child.pid }));
      }
      return child;
    };
  }

  async function expectDiagnosticsKept(): Promise<void> {
    expect(JSON.parse(await fs.readFile(lastFailureFilePath, 'utf8')).code).toBe('port-in-use');
  }

  beforeEach(async () => {
    child = undefined;
    spawnError = undefined;
    await fs.rm(stateFilePath, { force: true });
    await writeLastFailureFile({ code: 'port-in-use' });
    const existsSync = syncFs.existsSync;
    vi.spyOn(syncFs, 'existsSync').mockImplementation((file) => (
      /[\\/]sidecar[\\/]cli\.js$/.test(String(file)) || existsSync(file)
    ));
  });

  it('keeps a successfully verified child alive beyond the 30 s startup deadline', async () => {
    const health = await startHealthServer((_req, res) => { res.writeHead(200); res.end(); });
    fixture('ready', health.port);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await expect(hooks.ensureSidecar()).resolves.toMatchObject({ port: health.port, token: 'fixture-token' });
    expect(child!.pid).toBeGreaterThan(0);
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
    await expect(fs.stat(lastFailureFilePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await vi.advanceTimersByTimeAsync(31_000);
    await observeExit();

    expect(child!.signalCode).toBeNull();
    expect(child!.exitCode).toBeNull();
    expect(killSpy).not.toHaveBeenCalled();
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
  });

  it('times out once without ready output and signals only its owned child', async () => {
    const bystander = await startLivePid();
    fixture('silent');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rejection = expect(hooks.ensureSidecar()).rejects.toThrow('Sidecar startup timed out after 30s');
    const deadline = Date.now() + 2_000;
    while ((!child || vi.getTimerCount() === 0) && Date.now() < deadline) await realDelay(10);
    expect(child?.pid).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(31_000);
    await rejection;
    await observeExit();
    expect(child!.signalCode).toBe('SIGTERM');
    expect(killSpy).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
    await expectDiagnosticsKept();
  });

  it('preserves the original missing-executable error without a late kill attempt', async () => {
    fixture('missing');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const error = await hooks.ensureSidecar().catch((caught: Error) => caught);
    expect(error).toBe(spawnError);
    expect(error).toMatchObject({ code: 'ENOENT' });
    const callsAtRejection = killSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(killSpy).toHaveBeenCalledTimes(callsAtRejection);
    await expectDiagnosticsKept();
  });

  it('preserves a synchronous spawn exception when no child was assigned', async () => {
    const error = new Error('fixture spawn failed synchronously');
    sidecarSpawn.override = () => { throw error; };
    await expect(hooks.ensureSidecar()).rejects.toBe(error);
    await expectDiagnosticsKept();
  });

  it('rejects an early non-zero exit without a late kill attempt', async () => {
    fixture('exit');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await expect(hooks.ensureSidecar()).rejects.toThrow('Sidecar exited during startup (code=3)');
    expect(child!.exitCode).toBe(3);
    const callsAtRejection = killSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(killSpy).toHaveBeenCalledTimes(callsAtRejection);
    await expectDiagnosticsKept();
  });

  it('kills its child after ready output without readable state and preserves the error', async () => {
    const bystander = await startLivePid();
    fixture('ready');
    await expect(hooks.ensureSidecar()).rejects.toThrow('Sidecar started but state file did not become readable in time.');
    await observeExit();
    expect(child!.signalCode).toBe('SIGTERM');
    expect(killSpy).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
    await expectDiagnosticsKept();
  }, 12_000);

  it.each(['non-200', 'refused'] as const)('kills its child after ready output with %s health and preserves the error', async (mode) => {
    const health = await startHealthServer((_req, res) => { res.writeHead(500); res.end(); });
    if (mode === 'refused') {
      await health.close();
      cleanupServers.delete(health);
    }
    const bystander = await startLivePid();
    fixture('ready', health.port);
    await expect(hooks.ensureSidecar()).rejects.toThrow(`Sidecar state file points to port ${health.port} but /health is not responding.`);
    await observeExit();
    expect(child!.signalCode).toBe('SIGTERM');
    expect(killSpy).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
    await expectDiagnosticsKept();
  }, 12_000);

  it('adopts healthy state discovered while waiting on another live lock holder', async () => {
    const owner = await startLivePid();
    const health = await startHealthServer((_req, res) => { res.writeHead(200); res.end(); });
    const lockPath = path.join(stateDir, 'sidecar.lock');
    await fs.writeFile(lockPath, String(owner.pid));
    const unexpectedSpawn = vi.fn(() => { throw new Error('unexpected sidecar spawn'); });
    sidecarSpawn.override = unexpectedSpawn;
    try {
      const pending = hooks.ensureSidecar();
      await realDelay(50);
      await writeStateFile({ port: health.port, token: 'lock-owner-token', pid: owner.pid! });
      await expect(pending).resolves.toMatchObject({ token: 'lock-owner-token', pid: owner.pid });
      expect(unexpectedSpawn).not.toHaveBeenCalled();
      expect(() => process.kill(owner.pid!, 0)).not.toThrow();
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  });

  it('shares one lazy spawn between concurrent callers, then adopts it without signalling', async () => {
    const health = await startHealthServer((_req, res) => { res.writeHead(200); res.end(); });
    fixture('ready', health.port);
    const spawnOverride = vi.fn(sidecarSpawn.override!);
    sidecarSpawn.override = spawnOverride;
    const [first, second] = await Promise.all([hooks.ensureSidecar(), hooks.ensureSidecar()]);
    expect(first).toMatchObject({ pid: child!.pid });
    expect(second).toEqual(first);
    await expect(hooks.ensureSidecar()).resolves.toEqual(first);
    expect(spawnOverride).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
  });
});
