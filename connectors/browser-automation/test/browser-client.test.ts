import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  return {
    execFile,
    spawn: vi.fn(),
  };
});

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

describe('execAgentBrowser — argument shape', () => {
  let execAgentBrowser: typeof import('../src/browser-client.js')['execAgentBrowser'];
  const originalEnv = process.env.AGENT_BROWSER_SHOW_WINDOW;

  beforeEach(async () => {
    vi.resetModules();
    // Default tests assume the user has opted out of the visible window so we
    // can keep asserting the bare command shape. Tests that exercise the
    // visible default override this explicitly.
    process.env.AGENT_BROWSER_SHOW_WINDOW = 'false';
    const mod = await import('../src/browser-client.js');
    execAgentBrowser = mod.execAgentBrowser;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env.AGENT_BROWSER_SHOW_WINDOW;
    else process.env.AGENT_BROWSER_SHOW_WINDOW = originalEnv;
  });

  it('does NOT inject --headless (headless is the absence of --headed)', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    let capturedArgs: string[] | undefined;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      capturedArgs = args;
      callback(null, '', '');
    });

    await execAgentBrowser(['open', 'https://example.com']);

    expect(capturedArgs).toEqual(['open', 'https://example.com']);
  });

  it('preserves command as the first positional with no options', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    let capturedArgs: string[] | undefined;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      capturedArgs = args;
      callback(null, '', '');
    });

    await execAgentBrowser(['snapshot', '-i']);

    expect(capturedArgs![0]).toBe('snapshot');
    expect(capturedArgs).toEqual(['snapshot', '-i']);
  });

  it('injects --headed AFTER the command (not before) when headed=true', async () => {
    // Critical: agent-browser parses the first positional as the command name.
    // Putting --headed first would make the CLI report
    // "Unknown command: --headed" and exit 1.
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    let capturedArgs: string[] | undefined;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      capturedArgs = args;
      callback(null, '', '');
    });

    await execAgentBrowser(['open', 'https://example.com'], { headed: true });

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs![0]).toBe('open');
    expect(capturedArgs).toEqual(['open', '--headed', 'https://example.com']);
  });

  it('omits --headed when env opts out (AGENT_BROWSER_SHOW_WINDOW=false) and no caller override', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    let capturedArgs: string[] | undefined;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      capturedArgs = args;
      callback(null, '', '');
    });

    await execAgentBrowser(['click', '@e1']);

    expect(capturedArgs).toEqual(['click', '@e1']);
    expect(capturedArgs).not.toContain('--headed');
    expect(capturedArgs).not.toContain('--headless');
  });

  it('npx fallback uses pinned version (not @0.17 or @latest)', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    let firstCmd: string | undefined;
    let firstArgs: string[] | undefined;
    let secondCmd: string | undefined;
    let secondArgs: string[] | undefined;
    let callCount = 0;

    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, callback: Function) => {
      callCount++;
      if (callCount === 1) {
        firstCmd = cmd;
        firstArgs = args;
        callback(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      } else {
        secondCmd = cmd;
        secondArgs = args;
        callback(null, 'ok', '');
      }
    });

    const result = await execAgentBrowser(['open', 'https://example.com']);

    expect(firstCmd).toBe('agent-browser');
    expect(firstArgs).toEqual(['open', 'https://example.com']);
    expect(secondCmd).toBe('npx');
    // Pinned version, not 0.17 (older) or `latest` (flaky).
    expect(secondArgs![0]).toBe('-y');
    expect(secondArgs![1]).toMatch(/^agent-browser@\d+\.\d+\.\d+$/);
    expect(secondArgs![1]).not.toBe('agent-browser@0.17');
    expect(secondArgs!.slice(2)).toEqual(['open', 'https://example.com']);
    expect(result.stdout).toBe('ok');
  });
});

describe('execAgentBrowser — visibility resolution', () => {
  const originalEnv = process.env.AGENT_BROWSER_SHOW_WINDOW;
  let execAgentBrowser: typeof import('../src/browser-client.js')['execAgentBrowser'];

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env.AGENT_BROWSER_SHOW_WINDOW;
    else process.env.AGENT_BROWSER_SHOW_WINDOW = originalEnv;
  });

  async function loadWithEnv(value: string | undefined): Promise<void> {
    if (value === undefined) delete process.env.AGENT_BROWSER_SHOW_WINDOW;
    else process.env.AGENT_BROWSER_SHOW_WINDOW = value;
    vi.resetModules();
    const mod = await import('../src/browser-client.js');
    execAgentBrowser = mod.execAgentBrowser;
  }

  async function runAndCaptureArgs(callerArgs: string[], options?: { headed?: boolean }): Promise<string[]> {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    let captured: string[] | undefined;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      captured = args;
      callback(null, '', '');
    });

    await execAgentBrowser(callerArgs, options);
    return captured ?? [];
  }

  it('defaults to --headed when env is unset', async () => {
    await loadWithEnv(undefined);
    const args = await runAndCaptureArgs(['open', 'https://example.com']);
    expect(args).toEqual(['open', '--headed', 'https://example.com']);
  });

  it('defaults to --headed when env=true', async () => {
    await loadWithEnv('true');
    const args = await runAndCaptureArgs(['click', '@e1']);
    expect(args).toEqual(['click', '--headed', '@e1']);
  });

  it('omits --headed when env=false', async () => {
    await loadWithEnv('false');
    const args = await runAndCaptureArgs(['click', '@e1']);
    expect(args).toEqual(['click', '@e1']);
  });

  it('caller options.headed=true overrides env=false', async () => {
    await loadWithEnv('false');
    const args = await runAndCaptureArgs(['open', 'https://example.com'], { headed: true });
    expect(args).toEqual(['open', '--headed', 'https://example.com']);
  });

  it('caller options.headed=false overrides env=true', async () => {
    await loadWithEnv('true');
    const args = await runAndCaptureArgs(['snapshot'], { headed: false });
    expect(args).toEqual(['snapshot']);
  });

  it('treats env=FALSE (uppercase) and env=0 as opt-out', async () => {
    await loadWithEnv('FALSE');
    expect(await runAndCaptureArgs(['click', '@e1'])).toEqual(['click', '@e1']);
    await loadWithEnv('0');
    expect(await runAndCaptureArgs(['click', '@e1'])).toEqual(['click', '@e1']);
  });

  it('treats unknown env values as headed (visible default wins on ambiguity)', async () => {
    await loadWithEnv('maybe');
    const args = await runAndCaptureArgs(['open', 'https://example.com']);
    expect(args).toEqual(['open', '--headed', 'https://example.com']);
  });
});
