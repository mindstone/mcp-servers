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
});
