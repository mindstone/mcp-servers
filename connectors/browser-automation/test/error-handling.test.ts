import { describe, it, expect, afterAll, afterEach, vi, beforeEach } from 'vitest';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  return {
    execFile,
    spawn: vi.fn(),
  };
});

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => {
    return async (...args: unknown[]) => {
      const { execFile } = await import('node:child_process');
      const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
      return new Promise((resolve, reject) => {
        mockExecFile(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      });
    };
  },
}));

describe('Error handling — Browser Automation', () => {
  let testClient: McpTestClient;

  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('returns structured error when CLI command fails', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
      const error = Object.assign(new Error('Element not found'), {
        code: 1,
        stderr: 'Error: No element matching selector "@e99"',
        stdout: '',
      });
      callback(error);
    });

    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_click',
      arguments: { ref: '@e99' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeTruthy();
    expect(result.isError).toBe(true);
  });

  it('returns structured error when binary not found and npx fallback fails', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    let callCount = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
      callCount++;
      if (callCount === 1) {
        // First call: agent-browser not found
        callback(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      } else {
        // Second call: npx fallback also fails
        callback(Object.assign(new Error('npx failed'), { code: 'ENOENT' }));
      }
    });

    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('BINARY_NOT_FOUND');
    expect(parsed.resolution).toContain('npm install -g agent-browser');
    expect(result.isError).toBe(true);
  });

  it('returns structured error on timeout', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
      callback(Object.assign(new Error('Timeout'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        killed: true,
        stdout: '',
        stderr: '',
      }));
    });

    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_snapshot',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('TIMEOUT');
    expect(result.isError).toBe(true);
  });

  it('server stays alive after error — subsequent calls succeed', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    let callCount = 0;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      callCount++;
      if (callCount <= 1) {
        // First call fails
        const error = Object.assign(new Error('CLI error'), {
          code: 1,
          stderr: 'Something went wrong',
          stdout: '',
        });
        callback(error);
      } else {
        // Subsequent calls succeed
        callback(null, '', '');
      }
    });

    testClient = await createTestClient();

    // First call: error
    const errorResult = await testClient.client.callTool({
      name: 'browser_click',
      arguments: { ref: '@e1' },
    });
    const errorText = (errorResult.content as Array<{ type: string; text: string }>)[0].text;
    const errorParsed = JSON.parse(errorText);
    expect(errorParsed.ok).toBe(false);

    // Second call: should succeed (server still alive)
    const successResult = await testClient.client.callTool({
      name: 'browser_back',
      arguments: {},
    });
    const successText = (successResult.content as Array<{ type: string; text: string }>)[0].text;
    const successParsed = JSON.parse(successText);
    expect(successParsed.ok).toBe(true);
  });

  it('credentialless startup works — tools are usable without auth', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
      callback(null, '', '');
    });

    testClient = await createTestClient({ env: {} });

    // Verify tools list works
    const toolsResult = await testClient.client.listTools();
    expect(toolsResult.tools).toHaveLength(18);

    // Verify a tool call works without any credentials
    const result = await testClient.client.callTool({
      name: 'browser_back',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(true);
  });
});
