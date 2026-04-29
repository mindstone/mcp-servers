import { describe, it, expect, afterAll, afterEach, vi, beforeEach } from 'vitest';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

// Mock the execFile function used by browser-client
vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  return {
    execFile,
    spawn: vi.fn(),
  };
});

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => {
    // Return a function that calls the mocked execFile with a callback pattern
    return async (...args: unknown[]) => {
      const { execFile } = await import('node:child_process');
      const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

      // Get the last configured mock response
      return new Promise((resolve, reject) => {
        mockExecFile(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      });
    };
  },
}));

describe('Navigation tools — Browser Automation', () => {
  let testClient: McpTestClient;

  beforeEach(async () => {
    vi.resetModules();

    // Mock execFile to simulate agent-browser CLI responses
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      const command = args?.join(' ') ?? '';

      if (command.includes('open')) {
        callback(null, '', '');
      } else if (command.includes('get') && command.includes('title')) {
        callback(null, 'Test Page Title', '');
      } else if (command.includes('back')) {
        callback(null, '', '');
      } else if (command.includes('forward')) {
        callback(null, '', '');
      } else if (command.includes('wait')) {
        callback(null, '', '');
      } else {
        callback(null, '', '');
      }
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('browser_navigate returns success with page title', async () => {
    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('https://example.com');
  });

  it('browser_back returns success', async () => {
    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_back',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('back');
  });

  it('browser_forward returns success', async () => {
    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_forward',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('forward');
  });

  // Regression for the agent-browser arg-order bug: agent-browser parses the
  // FIRST positional as the command name. If we prepend a flag like
  // `--headless` or `--headed` before the command, the CLI errors with
  // "Unknown command: --headed" and exits 1.
  //
  // Headless is the default — no flag should be injected at all.
  it('does NOT inject --headless before the command (regression: agent-browser would reject it)', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    const capturedCalls: string[][] = [];
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      capturedCalls.push(args);
      callback(null, '', '');
    });

    testClient = await createTestClient();

    await testClient.client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    });

    // browser_navigate makes two CLI calls: `open <url>` then `get title`.
    // Both must have a real command as first positional, never a flag.
    expect(capturedCalls.length).toBeGreaterThanOrEqual(1);
    expect(capturedCalls[0][0]).toBe('open');
    for (const args of capturedCalls) {
      expect(args).not.toContain('--headless');
      // The valid flag is --headed, and only when explicitly opted-in.
      expect(args).not.toContain('--headed');
    }
  });

  it('first positional is always the agent-browser command (not a flag)', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    const allCapturedArgs: string[][] = [];
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      allCapturedArgs.push(args);
      callback(null, '', '');
    });

    testClient = await createTestClient();

    await testClient.client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } });
    await testClient.client.callTool({ name: 'browser_back', arguments: {} });
    await testClient.client.callTool({ name: 'browser_forward', arguments: {} });

    for (const args of allCapturedArgs) {
      expect(args.length).toBeGreaterThan(0);
      // The CLI command must be the first positional, never a flag.
      expect(args[0].startsWith('--')).toBe(false);
    }
  });
});
