import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { mswServer } from './helpers/setup.js';
import { createOpusHandlers } from './helpers/opus-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { mockProjectId } from './fixtures/opus-data.js';

const BASE = 'https://api.opus.pro';
const CANARY = 'fictional-transport-canary-7c1d';

let testClient: McpTestClient | undefined;

afterEach(async () => {
  if (testClient) await testClient.close();
  testClient = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function captureStderr(): () => string {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

async function client(apiKey: string): Promise<McpTestClient> {
  testClient = await createTestClient({ env: { OPUS_API_KEY: apiKey, MCP_HOST_BRIDGE_STATE: '' } });
  return testClient;
}

/** The whole outcome of a raw call, result or protocol error, as text. */
async function rawCall(c: McpTestClient, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    return JSON.stringify(await c.client.callTool({ name, arguments: args }));
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

/** A server built like createServer's, with one tool returning `text`. */
async function echoClient(apiKey: string, text: () => string): Promise<McpTestClient> {
  vi.stubEnv('OPUS_API_KEY', apiKey);
  vi.resetModules();
  const { withErrorHandling } = await import('../src/utils.js');
  const { withCredentialFilter } = await import('../src/server.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { createInMemoryTestClient } = await import('@mindstone/mcp-test-harness');
  const { z } = await import('zod');
  testClient = await createInMemoryTestClient({
    createServer: () => {
      const server = new McpServer({ name: 'echo', version: '0.0.0' });
      server.registerTool('echo', { inputSchema: z.object({}) }, withErrorHandling(async () => text()));
      return withCredentialFilter(server);
    },
  });
  return testClient;
}

describe('SDK-built errors are filtered at the transport', () => {
  it('an invalid enum argument containing the key', async () => {
    const c = await client(CANARY);
    const out = await rawCall(c, 'opus_create_project', {
      videoUrl: 'https://example.com/v.mp4',
      curationPref: { model: CANARY },
    });
    expect(out).not.toContain('canary');
    // The useful validation detail survives.
    expect(out).toMatch(/ClipBasic|invalid/i);
    expect(out).toContain('[REDACTED]');
  });

  it('an unknown tool name containing the key', async () => {
    const c = await client(CANARY);
    const out = await rawCall(c, `opus_${CANARY}`, {});
    expect(out).not.toContain('canary');
    expect(out).toContain('opus_[REDACTED]');
  });
});

describe('every credential seen this session stays filtered', () => {
  it('a response held across a reconfigure still has the old key removed, and stderr still filters it', async () => {
    const oldKey = `${CANARY}-old`;
    const newKey = 'fictional-replacement-key-92ab';
    let arrived!: () => void;
    const requestArrived = new Promise<void>((resolve) => (arrived = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    mswServer.use(
      http.get(`${BASE}/api/clip-projects/:projectId`, async () => {
        arrived();
        await released;
        return HttpResponse.json({ id: mockProjectId, stage: 'COMPLETE', note: oldKey, [oldKey]: 'x' });
      }),
      ...createOpusHandlers(newKey),
    );
    const stderr = captureStderr();
    const c = await client(oldKey);
    const pending = c.callTool('opus_get_project', { projectId: mockProjectId });
    await requestArrived;

    const configured = await c.callTool('configure_opus_api_key', { api_key: newKey });
    expect(configured.isError).toBeFalsy();
    release();
    const result = await pending;

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).not.toContain('canary');
    expect(result.text).toContain('[REDACTED]');

    const { logError } = await import('../src/key-filter.js');
    logError(`old ${oldKey} new ${newKey}`);
    expect(stderr()).toContain('old [REDACTED] new [REDACTED]');
    expect(stderr()).not.toContain('canary');
  });
});

describe('the replacement keeps results valid', () => {
  it('a key ending in a backslash leaves valid JSON', async () => {
    const key = `${CANARY}\\`;
    const c = await echoClient(key, () => JSON.stringify({ id: key, list: [key, `a${key}b`] }));
    const result = await c.callTool('echo', {});
    expect(result.json).toEqual({ id: '[REDACTED]', list: ['[REDACTED]', 'a[REDACTED]b'] });
  });

  it('keeps the JSON-RPC message valid when a key starts with an escape letter', async () => {
    // A literal backslash before the key serializes as `\\` then the key:
    // the key is removed and the backslash kept.
    const key = 'nfictional-escape-key';
    const c = await echoClient(key, () => `line a\\${key} hit ${key}`);
    const result = await c.callTool('echo', {});
    expect(result.text).toBe('line a\\[REDACTED] hit [REDACTED]');
  });

  it('a key shorter than 8 characters is not filtered and leaves results unchanged', async () => {
    // `content` is a 7-character key that is also an MCP member name.
    const c = await echoClient('content', () => JSON.stringify({ ok: true, note: 'content here' }));
    const raw = await c.client.callTool({ name: 'echo', arguments: {} });
    expect(raw.content).toEqual([{ type: 'text', text: '{"ok":true,"note":"content here"}' }]);
  });
});

describe('filterTransport', () => {
  async function wrapped(credential: string): Promise<{ sent: JSONRPCMessage[]; transport: Transport }> {
    vi.resetModules();
    const { filterTransport, rememberCredential } = await import('../src/key-filter.js');
    rememberCredential(credential);
    const sent: JSONRPCMessage[] = [];
    const transport = filterTransport({
      start: async () => {},
      close: async () => {},
      send: async (message: JSONRPCMessage) => {
        sent.push(message);
      },
    } as Transport);
    return { sent, transport };
  }

  it('filters notifications too', async () => {
    const { sent, transport } = await wrapped(CANARY);
    await transport.send({ jsonrpc: '2.0', method: 'notifications/message', params: { data: `log ${CANARY}` } });
    expect(sent).toEqual([{ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'log [REDACTED]' } }]);
  });

  it('sends a message with no credential unchanged', async () => {
    const { sent, transport } = await wrapped(CANARY);
    const message: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: { content: [] } };
    await transport.send(message);
    expect(sent[0]).toEqual(message);
  });
});
