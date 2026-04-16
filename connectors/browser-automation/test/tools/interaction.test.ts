import { describe, it, expect, afterAll, afterEach, vi, beforeEach } from 'vitest';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

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

describe('Interaction tools — Browser Automation', () => {
  let testClient: McpTestClient;

  beforeEach(async () => {
    vi.resetModules();

    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      const command = args?.join(' ') ?? '';

      if (command.includes('snapshot')) {
        callback(null, '<snapshot>\n@e1 [button] "Click me"\n@e2 [input] "Search"\n</snapshot>', '');
      } else if (command.includes('get') && command.includes('url')) {
        callback(null, 'https://example.com', '');
      } else if (command.includes('get') && command.includes('title')) {
        callback(null, 'Example Page', '');
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

  it('browser_click returns success', async () => {
    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_click',
      arguments: { ref: '@e1' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('@e1');
  });

  it('browser_fill returns success with character count', async () => {
    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_fill',
      arguments: { ref: '@e2', value: 'hello world' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('11 characters');
  });

  it('browser_snapshot returns accessibility tree', async () => {
    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_snapshot',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.snapshot).toContain('@e1');
  });

  it('browser_get_page_info returns url and title', async () => {
    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_get_page_info',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.url).toBe('https://example.com');
    expect(parsed.title).toBe('Example Page');
  });

  it('browser_press_key returns success', async () => {
    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_press_key',
      arguments: { key: 'Enter' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('Enter');
  });

  it('browser_scroll returns success', async () => {
    testClient = await createTestClient();

    const result = await testClient.client.callTool({
      name: 'browser_scroll',
      arguments: { direction: 'down', amount: 300 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('300px');
  });
});
