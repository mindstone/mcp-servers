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

  it('uses agent-browser alone when it is on PATH', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    const calls: string[] = [];
    mockExecFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, callback: Function) => {
      calls.push(cmd);
      callback(null, 'ok', '');
    });

    const result = await execAgentBrowser(['snapshot', '-i']);

    expect(calls).toEqual(['agent-browser']);
    expect(result.stdout).toBe('ok');
  });
});

describe('execAgentBrowser — bundled agent-browser when none is on PATH', () => {
  const originalEnv = process.env.AGENT_BROWSER_SHOW_WINDOW;
  // Matches either path separator, so the assertion holds on any host OS.
  const BIN_ENTRY = /[\\/]node_modules[\\/]agent-browser[\\/]bin[\\/]agent-browser\.js$/;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env.AGENT_BROWSER_SHOW_WINDOW;
    else process.env.AGENT_BROWSER_SHOW_WINDOW = originalEnv;
  });

  async function runAfterPathMiss(
    callerArgs: string[],
    options?: { headed?: boolean },
  ): Promise<{ calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>; stdout: string }> {
    vi.resetModules();
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    mockExecFile.mockImplementation(
      (cmd: string, args: string[], opts: Record<string, unknown>, callback: Function) => {
        calls.push({ cmd, args, opts });
        if (calls.length === 1) callback(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        else callback(null, 'ok', '');
      },
    );

    const { execAgentBrowser } = await import('../src/browser-client.js');
    const result = await execAgentBrowser(callerArgs, options);
    return { calls, stdout: result.stdout };
  }

  it('after a PATH miss, runs the bundled bin entry with this Node and no shell', async () => {
    process.env.AGENT_BROWSER_SHOW_WINDOW = 'false';
    const { calls, stdout } = await runAfterPathMiss(['fill', '@e3', 'line one\nline two']);

    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe('agent-browser');
    expect(calls[1].cmd).toBe(process.execPath);
    expect(calls[1].args[0]).toMatch(BIN_ENTRY);
    expect(calls[1].args.slice(1)).toEqual(['fill', '@e3', 'line one\nline two']);
    expect(calls[1].opts).toEqual(calls[0].opts);
    expect(calls[1].opts.windowsHide).toBe(true);
    expect(calls[1].opts).not.toHaveProperty('shell');
    expect(calls.map((c) => c.cmd)).not.toContain('npx');
    expect(calls[1].args).not.toContain('-y');
    expect(stdout).toBe('ok');
  });

  it('keeps --headed after the command in the bundled run', async () => {
    process.env.AGENT_BROWSER_SHOW_WINDOW = 'true';
    const { calls } = await runAfterPathMiss(['open', 'https://example.com']);

    expect(calls[1].cmd).toBe(process.execPath);
    expect(calls[1].args.slice(1)).toEqual(['open', '--headed', 'https://example.com']);
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

describe('execAgentBrowser — session autosave', () => {
  const originalInterval = process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalInterval === undefined) delete process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS;
    else process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS = originalInterval;
  });

  async function capturedEnv(): Promise<Record<string, string> | undefined> {
    vi.resetModules();
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;
    let env: Record<string, string> | undefined;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], opts: { env?: Record<string, string> }, callback: Function) => {
        env = opts.env;
        callback(null, '', '');
      },
    );
    const { execAgentBrowser } = await import('../src/browser-client.js');
    await execAgentBrowser(['snapshot']);
    return env;
  }

  // The CLI's periodic autosave opens a temporary tab that brings a headed
  // browser to the foreground every interval (30s by default). Save-on-close
  // still persists the session, so the periodic save is off unless the host
  // asks for it.
  it('disables periodic autosave by default', async () => {
    delete process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS;
    expect((await capturedEnv())?.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS).toBe('0');
  });

  it('passes an empty host value through untouched (the CLI then uses its own default)', async () => {
    process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS = '';
    expect((await capturedEnv())?.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS).toBe('');
  });

  it('keeps an interval the host set explicitly', async () => {
    process.env.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS = '60000';
    expect((await capturedEnv())?.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS).toBe('60000');
  });
});
