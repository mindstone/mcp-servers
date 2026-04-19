import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createMixmaxHandlers } from './helpers/mixmax-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_TOKEN = 'test-mixmax-token';

describe('Mixmax snippet tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup(opts?: { token?: string }) {
    mswServer.use(...createMixmaxHandlers(opts?.token ?? API_TOKEN));
    testClient = await createTestClient({
      env: {
        MIXMAX_API_TOKEN: opts?.token ?? API_TOKEN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  it('list_mixmax_snippets returns structured snippet data', async () => {
    await setup();
    const result = await testClient.callTool('list_mixmax_snippets', {});
    const json = result.json as {
      ok: boolean;
      snippets: Array<{ _id: string; name: string; isShared: boolean }>;
      count: number;
      hasNext: boolean;
    };

    expect(json.ok).toBe(true);
    expect(json.snippets).toHaveLength(2);
    expect(json.count).toBe(2);
    expect(json.snippets[0]).toHaveProperty('_id');
    expect(json.snippets[0]).toHaveProperty('name');
    expect(json.hasNext).toBe(false);
  });

  it('send_mixmax_snippet sends a template to recipients', async () => {
    await setup();
    const result = await testClient.callTool('send_mixmax_snippet', {
      snippetId: 'snip-001',
      to: ['alice@acme.com'],
      variables: { first_name: 'Alice', company: 'Acme' },
    });
    const json = result.json as { ok: boolean; message: string };

    expect(json.ok).toBe(true);
    expect(json.message).toContain('alice@acme.com');
  });

  it('send_mixmax_snippet rejects empty snippetId via Zod', async () => {
    let requestMade = false;
    const { http, HttpResponse } = await import('msw');
    mswServer.use(
      http.post('https://api.mixmax.com/v1/snippets/*/send', () => {
        requestMade = true;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { MIXMAX_API_TOKEN: API_TOKEN, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('send_mixmax_snippet', {
      snippetId: '',
      to: ['alice@acme.com'],
    });
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });
});
