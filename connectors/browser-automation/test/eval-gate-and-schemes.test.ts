/**
 * M3.12 — VAL-BROWSER-001..401
 *
 * Behavioural tests for:
 *   (a) `browser_evaluate` is registered by default (capability-first; the
 *       host's tool-approval layer gates invocations) and carries
 *       destructiveHint: true.
 *   (b) `browser_navigate` / `browser_authenticate` reject every blocked
 *       URL scheme before the agent-browser CLI is invoked.
 *
 * Also covers the README static-content assertions VAL-BROWSER-301..304.
 */

import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

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

interface ParsedToolResult {
  ok: boolean;
  error?: string;
  code?: string;
  message?: string;
  resolution?: string;
}

function parseResult(result: { content: unknown }): ParsedToolResult {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

describe('M3.12 — browser_evaluate registered by default (VAL-BROWSER-001..003)', () => {
  let testClient: McpTestClient | undefined;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined;
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('VAL-BROWSER-001 — default env: browser_evaluate is registered', async () => {
    testClient = await createTestClient();

    const tools = (await testClient.client.listTools()).tools;
    const evalTool = tools.find((t) => t.name === 'browser_evaluate');

    expect(evalTool).toBeDefined();
  });

  it('VAL-BROWSER-002 — legacy BROWSER_AUTOMATION_ALLOW_EVAL values are inert', async () => {
    // Deliberate regression guard: the retired opt-in env var must not gate
    // registration — the tool stays in the list whatever value it holds.
    for (const value of ['', '0', 'false']) {
      const client = await createTestClient({
        env: { BROWSER_AUTOMATION_ALLOW_EVAL: value },
      });
      try {
        const tools = (await client.client.listTools()).tools;
        const evalTool = tools.find((t) => t.name === 'browser_evaluate');
        expect(evalTool, `value=${JSON.stringify(value)} should not remove the tool`).toBeDefined();
      } finally {
        await client.close();
      }
    }
  });

  it('VAL-BROWSER-003 — browser_evaluate has destructiveHint: true', async () => {
    testClient = await createTestClient();

    const tools = (await testClient.client.listTools()).tools;
    const evalTool = tools.find((t) => t.name === 'browser_evaluate');

    expect(evalTool).toBeDefined();
    expect(evalTool!.annotations).toBeDefined();
    expect(evalTool!.annotations!.destructiveHint).toBe(true);
  });
});

const BLOCKED_NAVIGATE_CASES: ReadonlyArray<{ id: string; url: string }> = [
  { id: 'VAL-BROWSER-101', url: 'file:///etc/passwd' },
  { id: 'VAL-BROWSER-102', url: 'file:///Users/test/.ssh/id_rsa' },
  { id: 'VAL-BROWSER-103', url: 'chrome://settings' },
  { id: 'VAL-BROWSER-104', url: 'chrome-extension://abcdef/options.html' },
  { id: 'VAL-BROWSER-105', url: 'javascript:alert(1)' },
  { id: 'VAL-BROWSER-106', url: 'data:text/html,<script>x</script>' },
  { id: 'VAL-BROWSER-107', url: 'view-source:https://example.com' },
  { id: 'VAL-BROWSER-108', url: 'about:config' },
];

describe('M3.12 — browser_navigate scheme deny-list (VAL-BROWSER-101..111)', () => {
  let testClient: McpTestClient | undefined;
  let mockExecFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const childProcess = await import('node:child_process');
    mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
        callback(null, '', '');
      },
    );
  });

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined;
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  for (const { id, url } of BLOCKED_NAVIGATE_CASES) {
    it(`${id} — browser_navigate rejects ${url}`, async () => {
      testClient = await createTestClient();

      const callsBefore = mockExecFile.mock.calls.length;
      const result = await testClient.client.callTool({
        name: 'browser_navigate',
        arguments: { url },
      });
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(false);
      expect(result.isError).toBe(true);
      const errorText = `${parsed.error ?? ''} ${parsed.code ?? ''} ${parsed.resolution ?? ''}`;
      expect(errorText).toMatch(/scheme|protocol|http(s)?\s+only|not allowed/i);
      // The agent-browser CLI must NOT have been invoked.
      expect(mockExecFile.mock.calls.length).toBe(callsBefore);
    });
  }

  it('VAL-BROWSER-109 — browser_navigate allows about:blank', async () => {
    testClient = await createTestClient();

    const callsBefore = mockExecFile.mock.calls.length;
    const result = await testClient.client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'about:blank' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('VAL-BROWSER-110 — browser_navigate allows http://', async () => {
    testClient = await createTestClient();

    const callsBefore = mockExecFile.mock.calls.length;
    const result = await testClient.client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'http://example.com' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('VAL-BROWSER-111 — browser_navigate allows https://', async () => {
    testClient = await createTestClient();

    const callsBefore = mockExecFile.mock.calls.length;
    const result = await testClient.client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

const BLOCKED_AUTHENTICATE_CASES: ReadonlyArray<{ id: string; url: string }> = [
  { id: 'VAL-BROWSER-121', url: 'file:///etc/passwd' },
  { id: 'VAL-BROWSER-122', url: 'file:///Users/test/.ssh/id_rsa' },
  { id: 'VAL-BROWSER-123', url: 'chrome://settings' },
  { id: 'VAL-BROWSER-124', url: 'chrome-extension://abcdef/options.html' },
  { id: 'VAL-BROWSER-125', url: 'javascript:alert(1)' },
  { id: 'VAL-BROWSER-126', url: 'data:text/html,x' },
  { id: 'VAL-BROWSER-127', url: 'view-source:https://example.com' },
  { id: 'VAL-BROWSER-128', url: 'about:config' },
];

describe('M3.12 — browser_authenticate scheme deny-list (VAL-BROWSER-121..130)', () => {
  let testClient: McpTestClient | undefined;
  let mockExecFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const childProcess = await import('node:child_process');
    mockExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
        callback(null, '', '');
      },
    );
  });

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined;
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  for (const { id, url } of BLOCKED_AUTHENTICATE_CASES) {
    it(`${id} — browser_authenticate rejects ${url}`, async () => {
      testClient = await createTestClient();

      const callsBefore = mockExecFile.mock.calls.length;
      const result = await testClient.client.callTool({
        name: 'browser_authenticate',
        arguments: { url },
      });
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(false);
      expect(result.isError).toBe(true);
      const errorText = `${parsed.error ?? ''} ${parsed.code ?? ''} ${parsed.resolution ?? ''}`;
      expect(errorText).toMatch(/scheme|protocol|http(s)?\s+only|not allowed/i);
      expect(mockExecFile.mock.calls.length).toBe(callsBefore);
    });
  }

  it('VAL-BROWSER-129 — browser_authenticate allows about:blank', async () => {
    testClient = await createTestClient();

    const callsBefore = mockExecFile.mock.calls.length;
    const result = await testClient.client.callTool({
      name: 'browser_authenticate',
      arguments: { url: 'about:blank' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('VAL-BROWSER-130 — browser_authenticate allows https:// (spawn invoked with --headed)', async () => {
    testClient = await createTestClient();

    mockExecFile.mockClear();

    const result = await testClient.client.callTool({
      name: 'browser_authenticate',
      arguments: { url: 'https://login.example.com' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(mockExecFile.mock.calls.length).toBeGreaterThan(0);
    const firstCallArgs = mockExecFile.mock.calls[0][1] as string[];
    // browser-client.ts injects --headed AFTER the command (positional 1).
    expect(firstCallArgs).toContain('--headed');
  });
});

describe('M3.12 — README security section (VAL-BROWSER-301..304)', () => {
  const README_PATH = path.resolve(import.meta.dirname, '../README.md');
  const readme = fs.readFileSync(README_PATH, 'utf8');

  it('VAL-BROWSER-301 — has Security considerations section', () => {
    expect(readme).toMatch(/^##\s+Security/im);
  });

  it('VAL-BROWSER-302 — documents browser_evaluate default-on + host confirmation', () => {
    expect(readme).toContain('browser_evaluate');
    expect(readme).toMatch(/browser_evaluate[\s\S]{0,400}(by default|unconditionally|enabled)/i);
    // The retired opt-in env var must not be documented anymore.
    expect(readme).not.toContain('BROWSER_AUTOMATION_ALLOW_EVAL');
  });

  it('VAL-BROWSER-303 — documents cookie / session persistence + SESSION_NAME default mcp', () => {
    expect(readme).toMatch(/cookie/i);
    // Either SESSION_NAME or AGENT_BROWSER_SESSION_NAME must be referenced.
    expect(readme).toMatch(/(?:AGENT_BROWSER_)?SESSION_NAME/);
    // Default value `mcp` must be documented.
    expect(readme).toMatch(/\bmcp\b/);
  });

  it('VAL-BROWSER-304 — recommends a separate browser profile', () => {
    expect(readme).toMatch(/separate.*(browser|profile)|dedicated.*profile/i);
  });
});
