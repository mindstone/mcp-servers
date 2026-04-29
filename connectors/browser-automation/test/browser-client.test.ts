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

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/browser-client.js');
    execAgentBrowser = mod.execAgentBrowser;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT inject --headless (headless is the agent-browser default)', async () => {
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

  it('does not inject --headed when headed is unset (default headless)', async () => {
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
