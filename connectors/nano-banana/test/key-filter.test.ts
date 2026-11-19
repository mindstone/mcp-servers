/**
 * The output-boundary key filter: the configured API key never reaches a tool
 * result or a stderr line, wherever upstream echoes it.
 *
 * The canary key holds a double quote and a backslash, so both its raw form
 * and its JSON-escaped form (as it appears inside JSON text) are checked.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';
import { http, HttpResponse } from 'msw';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createMockBlockedResponse } from './fixtures/nano-banana-data.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const CANARY_KEY = 'canary-nano-"key\\-0000';
const ESCAPED_CANARY = JSON.stringify(CANARY_KEY).slice(1, -1);

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

/** Upstream text that echoes the key raw, JSON-escaped, as a nested member name and in an array. */
const ECHO_TEXT = `raw ${CANARY_KEY} json ${JSON.stringify({ outer: { [CANARY_KEY]: [CANARY_KEY, { id: CANARY_KEY }] } })}`;

function expectNoKey(serialised: string): void {
  expect(serialised).not.toContain(CANARY_KEY);
  expect(serialised).not.toContain(ESCAPED_CANARY);
  expect(serialised).not.toContain('canary-nano-');
  expect(serialised).toContain('[REDACTED]');
}

describe('output-boundary key filter: tool results', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-keyfilter-')));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  async function makeClient(): Promise<void> {
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: CANARY_KEY, MCP_HOST_BRIDGE_STATE: '', MCP_WORKSPACE_PATH: workspaceDir },
    });
  }

  function sourceImage(): string {
    const sourcePath = path.join(workspaceDir, 'in.png');
    fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);
    return sourcePath;
  }

  function geminiReplies(body: Record<string, unknown>): void {
    mswServer.use(
      http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, () => HttpResponse.json(body)),
    );
  }

  it('generate: a blockReason echoing the key', async () => {
    geminiReplies(createMockBlockedResponse(ECHO_TEXT));
    await makeClient();

    const result = await testClient.callTool('nano_banana_generate', { prompt: 'A cat' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Prompt was blocked');
    expectNoKey(JSON.stringify(result.content));
  });

  it('generate: candidate text echoing the key', async () => {
    geminiReplies({ candidates: [{ content: { parts: [{ text: ECHO_TEXT }] } }] });
    await makeClient();

    const result = await testClient.callTool('nano_banana_generate', { prompt: 'A cat' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('<untrusted-content source="gemini">');
    expectNoKey(JSON.stringify(result.content));
  });

  it('edit: a blockReason echoing the key', async () => {
    geminiReplies(createMockBlockedResponse(ECHO_TEXT));
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', { source_image_path: sourceImage(), prompt: 'rotate' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Prompt was blocked');
    expectNoKey(JSON.stringify(result.content));
  });

  it('edit: candidate text echoing the key', async () => {
    geminiReplies({ candidates: [{ content: { parts: [{ text: ECHO_TEXT }] } }] });
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', { source_image_path: sourceImage(), prompt: 'rotate' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('<untrusted-content source="gemini">');
    expectNoKey(JSON.stringify(result.content));
  });

  it('a key set by the configure tool is filtered from later results', async () => {
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: '', MCP_HOST_BRIDGE_STATE: '', MCP_WORKSPACE_PATH: workspaceDir },
    });
    // A configure tool accepts only plain keys (no quote or backslash), so this canary is plain.
    const configuredKey = 'canary-nano-configured-0000';
    const configured = await testClient.callTool('configure_nano_banana_api_key', { api_key: configuredKey });
    expect(configured.isError).toBeFalsy();
    geminiReplies(createMockBlockedResponse(`raw ${configuredKey} json ${JSON.stringify({ [configuredKey]: configuredKey })}`));

    const result = await testClient.callTool('nano_banana_generate', { prompt: 'A cat' });

    expectNoKey(JSON.stringify(result.content));
  });
});

describe('output-boundary key filter: every registered tool', () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** The real server, plus a probe tool registered the same way every tool is. */
  async function connectWithProbe(callback: () => Promise<unknown>): Promise<Client> {
    vi.stubEnv('GEMINI_API_KEY', CANARY_KEY);
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.resetModules();
    const { createServer } = await import('../src/server.js');
    const server = createServer();
    server.registerTool(
      'probe',
      { description: 'test probe', inputSchema: z.object({}) },
      callback as never,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'key-filter-test', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  it('removes the key from member names and values at any depth, in text and structured content', async () => {
    const connected = await connectWithProbe(async () => ({
      content: [{ type: 'text', text: ECHO_TEXT }],
      structuredContent: {
        [CANARY_KEY]: { nested: [CANARY_KEY, { [`id-${CANARY_KEY}`]: `value ${CANARY_KEY}` }] },
      },
    }));

    const result = await connected.callTool({ name: 'probe', arguments: {} });

    expectNoKey(JSON.stringify(result));
    expect(result.structuredContent).toEqual({
      '[REDACTED]': { nested: ['[REDACTED]', { 'id-[REDACTED]': 'value [REDACTED]' }] },
    });
  });

  it('a callback that throws with the key in its message gets fixed text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const connected = await connectWithProbe(async () => {
      throw new Error(`upstream said ${CANARY_KEY}`);
    });

    const result = await connected.callTool({ name: 'probe', arguments: {} });

    expect(result.isError).toBe(true);
    const serialised = JSON.stringify(result);
    expect(serialised).toContain('UNEXPECTED_ERROR');
    expect(serialised).not.toContain(CANARY_KEY);
    expect(serialised).not.toContain('canary-nano-');
  });
});

describe('output-boundary key filter: stderr', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('logError removes the key, raw and JSON-escaped, from strings and errors', async () => {
    vi.stubEnv('GEMINI_API_KEY', CANARY_KEY);
    vi.resetModules();
    // auth.ts registers the env key when it loads, as it does at startup.
    await import('../src/auth.js');
    const { logError } = await import('../src/key-filter.js');
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });

    logError(`[NanoBanana] url ?key=${CANARY_KEY}`, new Error(`body ${JSON.stringify({ [CANARY_KEY]: CANARY_KEY })}`));

    expect(lines).toHaveLength(1);
    expectNoKey(lines[0]);
  });

  it('a tool path that logs leaves no key on stderr', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); });
    mswServer.use(
      http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, () => HttpResponse.error()),
    );
    const testClient = await createTestClient({ env: { GEMINI_API_KEY: CANARY_KEY, MCP_HOST_BRIDGE_STATE: '' } });
    try {
      await testClient.callTool('nano_banana_generate', { prompt: 'A cat' });
    } finally {
      await testClient.close();
    }

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(CANARY_KEY);
  });

  it('with no key configured, text is unchanged', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.resetModules();
    const { redactCredentials } = await import('../src/key-filter.js');
    expect(redactCredentials('plain text')).toBe('plain text');
  });
});

/**
 * The real server over a linked in-memory pair, with every message the client
 * receives recorded, so assertions see exactly what crossed the transport,
 * including errors the SDK builds itself.
 */
describe('output-boundary key filter: the transport', () => {
  let client: Client | undefined;
  let received: unknown[] = [];

  afterEach(async () => {
    await client?.close();
    client = undefined;
    received = [];
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function connect(
    envKey: string,
    probe?: () => Promise<unknown>,
  ): Promise<{ client: Client; keyFilter: typeof import('../src/key-filter.js') }> {
    vi.stubEnv('GEMINI_API_KEY', envKey);
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.resetModules();
    const { createServer } = await import('../src/server.js');
    const keyFilter = await import('../src/key-filter.js');
    const server = createServer();
    if (probe) {
      server.registerTool('probe', { description: 'test probe', inputSchema: z.object({}) }, probe as never);
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'key-filter-transport-test', version: '1.0.0' });
    await client.connect(clientTransport);
    const onmessage = clientTransport.onmessage;
    clientTransport.onmessage = (message, extra) => {
      received.push(message);
      onmessage?.(message, extra);
    };
    return { client, keyFilter };
  }

  async function settle<T>(call: Promise<T>): Promise<unknown> {
    try {
      return await call;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('an SDK validation error quoting an invalid enum argument is key-free', async () => {
    const { client: c } = await connect(CANARY_KEY);

    const outcome = await settle(c.callTool({ name: 'nano_banana_generate', arguments: { prompt: 'A cat', model: CANARY_KEY } }));

    const wire = JSON.stringify(received);
    expect(wire).toMatch(/invalid|validation/i);
    expectNoKey(wire);
    expect(JSON.stringify(outcome)).not.toContain('canary-nano-');
  });

  it('an unknown tool name containing the key is key-free', async () => {
    const { client: c } = await connect(CANARY_KEY);

    const outcome = await settle(c.callTool({ name: `tool-${CANARY_KEY}`, arguments: {} }));

    const wire = JSON.stringify(received);
    expect(wire).toMatch(/not found|unknown/i);
    expectNoKey(wire);
    expect(JSON.stringify(outcome)).not.toContain('canary-nano-');
  });

  it('a request held across a reconfigure still has the old key filtered, on the wire and on stderr', async () => {
    const OLD_KEY = 'old-fictional-key-0001';
    const NEW_KEY = 'new-fictional-key-0002';
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { client: c, keyFilter } = await connect(OLD_KEY, async () => {
      await held;
      return { content: [{ type: 'text', text: `late echo ${OLD_KEY} ${JSON.stringify({ [OLD_KEY]: OLD_KEY })}` }] };
    });

    const pending = c.callTool({ name: 'probe', arguments: {} });
    const configured = await c.callTool({ name: 'configure_nano_banana_api_key', arguments: { api_key: NEW_KEY } });
    expect(configured.isError).toBeFalsy();
    release();
    const result = await pending;

    const text = JSON.stringify(result);
    expect(text).not.toContain(OLD_KEY);
    expect(text).toContain('late echo [REDACTED]');
    expect(JSON.stringify(received)).not.toContain(OLD_KEY);

    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });
    keyFilter.logError(`old ${OLD_KEY} new ${NEW_KEY}`);
    expect(lines).toEqual(['old [REDACTED] new [REDACTED]']);
  });

  it('a key ending in a backslash leaves results valid JSON', async () => {
    const KEY = 'fictional-key-ends-in\\';
    const { client: c } = await connect(KEY, async () => ({
      content: [{ type: 'text', text: JSON.stringify({ echoed: KEY, [KEY]: [KEY] }) }],
      structuredContent: { echoed: KEY, list: [`x${KEY}`] },
    }));

    const result = await c.callTool({ name: 'probe', arguments: {} });

    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ echoed: '[REDACTED]', '[REDACTED]': ['[REDACTED]'] });
    expect(result.structuredContent).toEqual({ echoed: '[REDACTED]', list: ['x[REDACTED]'] });
    expect(JSON.stringify(received)).not.toContain('fictional-key-ends-in');
  });

  it('a key shorter than 8 characters is not filtered and leaves ordinary results unchanged', async () => {
    const SHORT_KEY = 'content';
    const { client: c, keyFilter } = await connect(SHORT_KEY, async () => ({
      content: [{ type: 'text', text: 'ordinary content, nothing secret' }],
    }));

    const result = await c.callTool({ name: 'probe', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'ordinary content, nothing secret' }]);
    expect(keyFilter.redactCredentials(`text ${SHORT_KEY}`)).toBe(`text ${SHORT_KEY}`);
  });
});
