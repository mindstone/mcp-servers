import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

vi.mock('node:util', () => ({
  promisify: () => async (...args: unknown[]) => {
    const { execFile } = await import('node:child_process');
    const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
    return new Promise((resolve, reject) => {
      mockExecFile(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  },
}));

interface Call {
  file: string;
  args: string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** Answer each command with `respond`; by default every command succeeds. */
async function mockCommands(respond?: (call: Call, timeoutMs: number, done: Function) => void) {
  const childProcess = await import('node:child_process');
  const execFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;
  execFile.mockReset();
  const calls: Call[] = [];
  execFile.mockImplementation((file: string, args: string[], ...rest: unknown[]) => {
    const done = rest.at(-1) as Function;
    const options = rest.length > 1
      ? (rest[0] as { env?: Record<string, string>; timeout?: number; signal?: AbortSignal })
      : {};
    const call = { file, args, env: options.env, signal: options.signal };
    calls.push(call);
    if (respond) respond(call, options.timeout ?? 0, done);
    else done(null, '', '');
  });
  return calls;
}

describe('stopping the server', () => {
  async function setup({ spawnError }: { spawnError?: Error } = {}) {
    vi.resetModules();
    const calls = await mockCommands();
    const childProcess = await import('node:child_process');
    const spawn = childProcess.spawn as unknown as ReturnType<typeof vi.fn>;
    spawn.mockReset();
    const closer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawn.mockImplementation(() => {
      queueMicrotask(() => (spawnError ? closer.emit('error', spawnError) : closer.emit('spawn')));
      return closer;
    });
    const browserClient = await import('../src/browser-client.js');
    const { closeBrowserWhenHostStops } = await import('../src/stop.js');
    const stdin = new EventEmitter();
    const signals = new EventEmitter();
    let exited: () => void = () => {};
    const exitedPromise = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const exit = vi.fn(() => exited());
    closeBrowserWhenHostStops(stdin, signals, exit);
    return { browserClient, calls, closer, spawn, stdin, signals, exit, exitedPromise };
  }

  beforeEach(() => {
    vi.stubEnv('AGENT_BROWSER_SHOW_WINDOW', 'false');
  });

  it('hands the close to one detached process and exits, without waiting for it', async () => {
    const { browserClient, closer, spawn, stdin, exit, exitedPromise } = await setup();
    await browserClient.execAgentBrowser(['open', 'https://example.com']);

    stdin.emit('end');
    stdin.emit('close');
    await exitedPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawn.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args[0]).toMatch(/close-browser\.js$/);
    expect(options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(closer.unref).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does the same on SIGTERM', async () => {
    const { browserClient, spawn, signals, exitedPromise } = await setup();
    await browserClient.execAgentBrowser(['open', 'https://example.com']);

    signals.emit('SIGTERM');
    await exitedPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('touches no browser when this process never ran a browser command', async () => {
    const { calls, spawn, stdin, exit, exitedPromise } = await setup();

    stdin.emit('end');
    await exitedPromise;

    expect(calls).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still exits, and says so, when the closing process cannot start', async () => {
    const { browserClient, stdin, exit, exitedPromise } = await setup({ spawnError: new Error('no such file') });
    await browserClient.execAgentBrowser(['open', 'https://example.com']);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    stdin.emit('end');
    await exitedPromise;

    expect(exit).toHaveBeenCalledWith(0);
    expect(consoleError).toHaveBeenCalled();
  });

  it('ends commands still running, so no client outlives the daemon and starts a new one', async () => {
    const { browserClient, calls, stdin, exitedPromise } = await setup();
    await browserClient.execAgentBrowser(['open', 'https://example.com']);
    expect(calls[0].signal?.aborted).toBe(false);

    stdin.emit('end');
    await exitedPromise;

    expect(calls[0].signal?.aborted).toBe(true);
  });

  it('refuses new browser commands once stopping', async () => {
    const { browserClient, stdin, exitedPromise } = await setup();
    await browserClient.execAgentBrowser(['open', 'https://example.com']);

    stdin.emit('end');
    await exitedPromise;

    await expect(browserClient.execAgentBrowser(['snapshot'])).rejects.toMatchObject({ code: 'STOPPING' });
  });
});

describe('the close command', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('AGENT_BROWSER_SHOW_WINDOW', 'true');
    vi.stubEnv('AGENT_BROWSER_EXECUTABLE_PATH', '/no/such/browser');
    vi.stubEnv('AGENT_BROWSER_SOCKET_DIR', '/run/browser');
    vi.stubEnv('AGENT_BROWSER_SESSION', 'work');
  });

  it('carries no launch setting, which would launch a browser before closing', async () => {
    const calls = await mockCommands();
    const { execAgentBrowser } = await import('../src/browser-client.js');

    await execAgentBrowser(['close']);

    expect(calls[0].args).toEqual(['close']);
    expect(calls[0].env).not.toHaveProperty('AGENT_BROWSER_EXECUTABLE_PATH');
    expect(calls[0].env).not.toHaveProperty('AGENT_BROWSER_SHOW_WINDOW');
  });

  it('still reaches the same daemon', async () => {
    const calls = await mockCommands();
    const { execAgentBrowser } = await import('../src/browser-client.js');

    await execAgentBrowser(['close']);

    expect(calls[0].env).toMatchObject({ AGENT_BROWSER_SOCKET_DIR: '/run/browser', AGENT_BROWSER_SESSION: 'work' });
  });

  it('leaves other commands their launch settings', async () => {
    const calls = await mockCommands();
    const { execAgentBrowser } = await import('../src/browser-client.js');

    await execAgentBrowser(['open', 'https://example.com']);

    expect(calls[0].args).toEqual(['open', '--headed', 'https://example.com']);
    expect(calls[0].env).toMatchObject({ AGENT_BROWSER_EXECUTABLE_PATH: '/no/such/browser' });
  });
});

describe('closing the browser for good', () => {
  const DAEMON = 424242;
  const CHROME = 424243;
  let dir: string;
  let pidFile: string;
  let kill: ReturnType<typeof vi.spyOn>;
  // Pids that process.kill(pid, 0) finds alive.
  let alive: Set<number>;
  let onKill: ((pid: number) => void) | undefined;

  const signalsSent = () => kill.mock.calls.filter(([, signal]) => signal !== 0);
  const closes = (calls: Call[]) => calls.filter((call) => call.args.includes('close'));

  /** Run closeBrowserForGood to the end, however long its timers take. */
  async function closeForGood() {
    const { closeBrowserForGood } = await import('../src/browser-client.js');
    const finished = closeBrowserForGood();
    await vi.runAllTimersAsync();
    await finished;
  }

  const closeRemovesDaemon = (call: Call, _timeoutMs: number, done: Function) => {
    if (call.args.includes('close')) rmSync(pidFile, { force: true });
    done(null, '', '');
  };

  /** A daemon stuck on a command: the close times out, as execFile would make it. */
  const closeHangs = (call: Call, timeoutMs: number, done: Function) => {
    if (call.args.includes('close')) {
      setTimeout(() => done(Object.assign(new Error('timed out'), { killed: true })), timeoutMs);
    } else if (call.file === 'pgrep') {
      done(null, alive.has(CHROME) ? `${CHROME}\n` : '', '');
    } else {
      if (call.file === 'taskkill') alive.clear();
      done(null, '', '');
    }
  };

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'browser-stop-'));
    pidFile = join(dir, 'default.pid');
    vi.stubEnv('AGENT_BROWSER_SOCKET_DIR', dir);
    vi.stubEnv('AGENT_BROWSER_SESSION', '');
    alive = new Set([DAEMON, CHROME]);
    onKill = undefined;
    writeFileSync(pidFile, `${DAEMON}\n`);
    kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (!alive.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      if (signal === 'SIGKILL') {
        alive.delete(pid);
        onKill?.(pid);
      }
      return true;
    }) as typeof process.kill);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never force-stops a daemon that a close ended', async () => {
    const calls = await mockCommands(closeRemovesDaemon);

    await closeForGood();

    expect(closes(calls)).toHaveLength(1);
    expect(signalsSent()).toEqual([]);
  });

  it('closes again when a command that was still running brings the daemon back', async () => {
    let closed = 0;
    const calls = await mockCommands((call, timeoutMs, done) => {
      closed += 1;
      if (closed === 2) rmSync(pidFile, { force: true });
      done(null, '', '');
    });

    await closeForGood();

    expect(closes(calls)).toHaveLength(2);
    expect(signalsSent()).toEqual([]);
  });

  it('force-stops the daemon and its children when the close never gets through', async () => {
    await mockCommands(closeHangs);

    await closeForGood();

    expect(signalsSent()).toEqual([[CHROME, 'SIGKILL'], [DAEMON, 'SIGKILL']]);
  });

  it('gives a stuck close its whole budget, and no more, before force-stopping', async () => {
    await mockCommands(closeHangs);
    const started = Date.now();
    let forcedAfter = 0;
    onKill = () => {
      forcedAfter ||= Date.now() - started;
    };

    await closeForGood();

    expect(forcedAfter).toBeGreaterThanOrEqual(8_000);
    expect(forcedAfter).toBeLessThan(10_000);
  });

  it('keeps trying a close that fails straight away, then force-stops once the budget is spent', async () => {
    const calls = await mockCommands((call, timeoutMs, done) => {
      if (call.args.includes('close')) done(Object.assign(new Error('boom'), { stderr: 'failed' }), '', 'failed');
      else done(null, alive.has(CHROME) ? `${CHROME}\n` : '', '');
    });

    await closeForGood();

    expect(closes(calls).length).toBeGreaterThan(1);
    expect(signalsSent()).toEqual([[CHROME, 'SIGKILL'], [DAEMON, 'SIGKILL']]);
  });

  it('stops the daemon when it has no children', async () => {
    await mockCommands((call, timeoutMs, done) => {
      if (call.file === 'pgrep') done(Object.assign(new Error('no match'), { code: 1 }), '', '');
      else closeHangs(call, timeoutMs, done);
    });

    await closeForGood();

    expect(signalsSent()).toEqual([[DAEMON, 'SIGKILL']]);
  });

  it('stops the whole tree with taskkill on Windows', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const calls = await mockCommands(closeHangs);

    await closeForGood();
    platform.mockRestore();

    expect(calls.find((call) => call.file === 'taskkill')?.args).toEqual(['/PID', String(DAEMON), '/T', '/F']);
    expect(signalsSent()).toEqual([]);
  });

  it('signals nothing when the pid file names a process that has gone', async () => {
    alive.clear();
    await mockCommands(closeHangs);

    await closeForGood();

    expect(signalsSent()).toEqual([]);
  });

  it.each(['0', '1', '-1', 'not-a-pid', ''])('signals nothing for the pid file contents %j', async (contents) => {
    writeFileSync(pidFile, contents);
    await mockCommands(closeHangs);

    await closeForGood();

    expect(kill).not.toHaveBeenCalled();
  });

  it('finds the pid file of a named session', async () => {
    vi.stubEnv('AGENT_BROWSER_SESSION', 'work');
    rmSync(pidFile);
    writeFileSync(join(dir, 'work.pid'), `${DAEMON}`);
    await mockCommands(closeHangs);

    await closeForGood();

    expect(signalsSent()).toContainEqual([DAEMON, 'SIGKILL']);
  });
});
