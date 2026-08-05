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

  it('uploads a workspace file to the given ref via a private staging copy', async () => {
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
    const cliArgs = capturedArgs[0];
    expect(cliArgs[0]).toBe('upload');
    expect(cliArgs[1]).toBe('@e3');
    // The CLI receives a staged copy — never the validated pathname — with
    // only the requested basename carried over.
    const staged = cliArgs[2];
    expect(staged).not.toBe(filePath);
    expect(path.basename(staged)).toBe('report.pdf');
    expect(staged.startsWith(workspace + path.sep)).toBe(true);
  });

  it('stages the exact validated bytes and discards the staging dir afterwards', async () => {
    const filePath = path.join(workspace, 'report.pdf');
    fs.writeFileSync(filePath, 'pdf-bytes');

    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;
    let stagedDuringCli: string | undefined;
    let stagedContent: string | undefined;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      capturedArgs.push(args);
      stagedDuringCli = args[2];
      stagedContent = fs.readFileSync(stagedDuringCli, 'utf8');
      callback(null, '', '');
    });

    testClient = await createTestClient({
      env: { AGENT_BROWSER_SHOW_WINDOW: 'false', MCP_WORKSPACE_PATH: workspace },
    });

    const result = await testClient.client.callTool({
      name: 'browser_upload',
      arguments: { ref: '@e3', file_paths: ['report.pdf'] },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(stagedContent).toBe('pdf-bytes');
    // Controlled lifetime: the staging directory is gone once the call ends.
    const stagingDir = path.dirname(path.dirname(stagedDuringCli!));
    expect(fs.existsSync(stagingDir)).toBe(false);
    // The original is untouched.
    expect(fs.readFileSync(filePath, 'utf8')).toBe('pdf-bytes');
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
    const cliArgs = capturedArgs[0];
    expect(cliArgs[0]).toBe('upload');
    expect(cliArgs[1]).toBe('#file-input');
    expect(cliArgs.slice(2).map((p) => path.basename(p))).toEqual(['a.txt', 'b.txt']);
    // Distinct staging slots per file.
    expect(cliArgs[2]).not.toBe(cliArgs[3]);
  });

  it('rejects a directory as an upload source', async () => {
    fs.mkdirSync(path.join(workspace, 'a-directory'));

    testClient = await createTestClient({
      env: { AGENT_BROWSER_SHOW_WINDOW: 'false', MCP_WORKSPACE_PATH: workspace },
    });

    const result = await testClient.client.callTool({
      name: 'browser_upload',
      arguments: { ref: '@e3', file_paths: ['a-directory'] },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(parsed.code).toBe('NOT_A_REGULAR_FILE');
    expect(capturedArgs).toHaveLength(0);
  });

  it('discards the staging dir when the CLI fails', async () => {
    fs.writeFileSync(path.join(workspace, 'report.pdf'), 'pdf-bytes');

    const childProcess = await import('node:child_process');
    const mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;
    let stagedDuringCli: string | undefined;
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, callback: Function) => {
      capturedArgs.push(args);
      stagedDuringCli = args[2];
      callback(Object.assign(new Error('boom'), { code: 1, stderr: 'upload failed', stdout: '' }));
    });

    testClient = await createTestClient({
      env: { AGENT_BROWSER_SHOW_WINDOW: 'false', MCP_WORKSPACE_PATH: workspace },
    });

    const result = await testClient.client.callTool({
      name: 'browser_upload',
      arguments: { ref: '@e3', file_paths: ['report.pdf'] },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('CLI_ERROR');
    const stagingDir = path.dirname(path.dirname(stagedDuringCli!));
    expect(fs.existsSync(stagingDir)).toBe(false);
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

  it('fails closed (with a stderr warning) when the workspace root cannot be canonicalised', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = path.join(workspace, 'does-not-exist');

    testClient = await createTestClient({
      env: { AGENT_BROWSER_SHOW_WINDOW: 'false', MCP_WORKSPACE_PATH: missing },
    });

    const result = await testClient.client.callTool({
      name: 'browser_upload',
      arguments: { ref: '@e3', file_paths: ['report.pdf'] },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(parsed.code).toBe('WORKSPACE_ROOT_UNAVAILABLE');
    expect(capturedArgs).toHaveLength(0);
    // The failed pre-check must be observable, not silent.
    expect(stderrSpy).toHaveBeenCalled();
  });
});
