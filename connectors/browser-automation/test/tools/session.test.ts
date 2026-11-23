import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

vi.mock('node:util', () => ({
  promisify: () => async (...args: unknown[]) => {
    const { execFile } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      (execFile as unknown as ReturnType<typeof vi.fn>)(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  },
}));

describe('Session tools — Browser Automation', () => {
  let testClient: McpTestClient | undefined;

  afterEach(async () => {
    await testClient?.close();
    vi.restoreAllMocks();
  });

  it('browser_tabs switches by the id the tab list shows', async () => {
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
      callback(null, '', '');
    });
    testClient = await createTestClient();

    const result = await testClient.client.callTool({ name: 'browser_tabs', arguments: { tab_number: 2 } });

    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
    expect(parsed.ok).toBe(true);
    const args = mockExecFile.mock.calls.at(-1)?.[1] as string[];
    expect(args[0]).toBe('tab');
    expect(args.at(-1)).toBe('t2');
  });
});
