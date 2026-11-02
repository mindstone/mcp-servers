import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

async function setup() {
  vi.resetModules();
  const childProcess = await import('node:child_process');
  const execFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;
  execFile.mockReset();
  const calls: string[][] = [];
  // Set `hold.next = true` to keep the next `open` running until `hold.release()`.
  const hold = { next: false, release: () => {} };
  execFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
    calls.push(args);
    if (hold.next && args[0] === 'open') {
      hold.next = false;
      hold.release = () => callback(null, '', '');
      return;
    }
    callback(null, '', '');
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
  return { browserClient, calls, hold, stdin, signals, exit, exitedPromise };
}

const closeCalls = (calls: string[][]) => calls.filter((args) => args.includes('close'));

describe('closing the browser when the host stops the server', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_BROWSER_SHOW_WINDOW', 'false');
  });

  it('closes the browser once and exits when stdin ends after a browser command', async () => {
    const { browserClient, calls, stdin, exit, exitedPromise } = await setup();
    await browserClient.execAgentBrowser(['open', 'https://example.com']);

    stdin.emit('end');
    stdin.emit('close');
    await exitedPromise;

    expect(closeCalls(calls)).toHaveLength(1);
    expect(closeCalls(calls)[0]).toEqual(expect.arrayContaining(['close']));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('closes the browser on SIGTERM', async () => {
    const { browserClient, calls, signals, exitedPromise } = await setup();
    await browserClient.execAgentBrowser(['open', 'https://example.com']);

    signals.emit('SIGTERM');
    await exitedPromise;

    expect(closeCalls(calls)).toHaveLength(1);
  });

  it('touches no browser when this process never ran a browser command', async () => {
    const { calls, stdin, exit, exitedPromise } = await setup();

    stdin.emit('end');
    await exitedPromise;

    expect(calls).toHaveLength(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still exits when closing the browser fails', async () => {
    const { browserClient, stdin, exit, exitedPromise } = await setup();
    await browserClient.execAgentBrowser(['open', 'https://example.com']);
    const childProcess = await import('node:child_process');
    (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
        callback(Object.assign(new Error('boom'), { stderr: 'daemon gone' }), '', 'daemon gone');
      },
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    stdin.emit('end');
    await exitedPromise;

    expect(exit).toHaveBeenCalledWith(0);
    expect(consoleError).toHaveBeenCalled();
  });

  it('refuses new browser commands once stopping', async () => {
    const { browserClient, stdin, exitedPromise } = await setup();
    await browserClient.execAgentBrowser(['open', 'https://example.com']);

    stdin.emit('end');
    await exitedPromise;

    await expect(browserClient.execAgentBrowser(['snapshot'])).rejects.toMatchObject({ code: 'STOPPING' });
  });

  it('closes again after a command that was still running when the stop began', async () => {
    const { browserClient, calls, hold, stdin, exitedPromise } = await setup();
    await browserClient.execAgentBrowser(['open', 'https://example.com']);
    hold.next = true;
    const slowOpen = browserClient.execAgentBrowser(['open', 'https://example.org']);
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    stdin.emit('end');
    await vi.waitFor(() => expect(closeCalls(calls)).toHaveLength(1));
    hold.release();
    await slowOpen;
    await exitedPromise;

    expect(closeCalls(calls)).toHaveLength(2);
    expect(calls.at(-1)?.[0]).toBe('close');
  });
});
