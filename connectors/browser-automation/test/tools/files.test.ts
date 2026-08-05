import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

interface ParsedToolResult {
  ok: boolean;
  error?: string;
  code?: string;
  message?: string;
}

function parseResult(result: { content: unknown }): ParsedToolResult {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

describe('browser_upload', () => {
  let testClient: McpTestClient | undefined;
  let workspace: string;
  let capturedArgs: string[][];

  beforeEach(async () => {
    vi.resetModules();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-test-'));
    capturedArgs = [];
    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      capturedArgs.push(args);
      callback(null, '', '');
    });
  });

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined;
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('uploads a workspace file to the given ref', async () => {
    const filePath = path.join(workspace, 'report.pdf');
    fs.writeFileSync(filePath, 'pdf-bytes');

    testClient = await createTestClient({
      env: { AGENT_BROWSER_SHOW_WINDOW: 'false', MCP_WORKSPACE_PATH: workspace },
    });

    const result = await testClient.client.callTool({
      name: 'browser_upload',
      arguments: { ref: '@e3', file_paths: ['report.pdf'] },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('@e3');
    expect(capturedArgs[0]).toEqual(['upload', '@e3', filePath]);
  });

  it('uploads multiple files in one call', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'a');
    fs.writeFileSync(path.join(workspace, 'b.txt'), 'b');

    testClient = await createTestClient({
      env: { AGENT_BROWSER_SHOW_WINDOW: 'false', MCP_WORKSPACE_PATH: workspace },
    });

    const result = await testClient.client.callTool({
      name: 'browser_upload',
      arguments: { ref: '#file-input', file_paths: ['a.txt', 'b.txt'] },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(capturedArgs[0]).toEqual([
      'upload',
      '#file-input',
      path.join(workspace, 'a.txt'),
      path.join(workspace, 'b.txt'),
    ]);
  });

  it('rejects a file that does not exist', async () => {
    testClient = await createTestClient({
      env: { AGENT_BROWSER_SHOW_WINDOW: 'false', MCP_WORKSPACE_PATH: workspace },
    });

    const result = await testClient.client.callTool({
      name: 'browser_upload',
      arguments: { ref: '@e3', file_paths: ['missing.pdf'] },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(parsed.code).toBe('PATH_OUTSIDE_WORKSPACE');
    expect(capturedArgs).toHaveLength(0);
  });

  it('rejects path traversal outside the workspace before invoking the CLI', async () => {
    testClient = await createTestClient({
      env: { AGENT_BROWSER_SHOW_WINDOW: 'false', MCP_WORKSPACE_PATH: workspace },
    });

    const result = await testClient.client.callTool({
      name: 'browser_upload',
      arguments: { ref: '@e3', file_paths: ['../../../../etc/passwd'] },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('PATH_OUTSIDE_WORKSPACE');
    expect(capturedArgs).toHaveLength(0);
  });

  it('rejects an in-workspace symlink pointing outside the workspace', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-outside-'));
    try {
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'secret');
      fs.symlinkSync(outsideFile, path.join(workspace, 'link.txt'));

      testClient = await createTestClient({
        env: { AGENT_BROWSER_SHOW_WINDOW: 'false', MCP_WORKSPACE_PATH: workspace },
      });

      const result = await testClient.client.callTool({
        name: 'browser_upload',
        arguments: { ref: '@e3', file_paths: ['link.txt'] },
      });
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('PATH_OUTSIDE_WORKSPACE');
      expect(capturedArgs).toHaveLength(0);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects an empty file_paths array at the schema boundary', async () => {
    testClient = await createTestClient({
      env: { AGENT_BROWSER_SHOW_WINDOW: 'false', MCP_WORKSPACE_PATH: workspace },
    });

    const result = await testClient.client.callTool({
      name: 'browser_upload',
      arguments: { ref: '@e3', file_paths: [] },
    });

    expect(result.isError).toBe(true);
    expect(capturedArgs).toHaveLength(0);
  });
});
