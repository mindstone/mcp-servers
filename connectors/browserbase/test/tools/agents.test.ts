import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import { createBrowserbaseHandlers, MOCK_API_KEY, AGENT_ID, CONTEXT_ID } from '../helpers/browserbase-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Agent + context tools — Browserbase', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  const makeClient = async () => {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({
      env: { BROWSERBASE_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });
    return testClient;
  };

  it('create_agent sends name/systemPrompt/resultSchema and wraps external text', async () => {
    const client = await makeClient();
    const result = await client.callTool('create_agent', {
      name: 'Acme pricing extractor',
      system_prompt: 'You extract pricing from Acme Corp pages.',
      result_schema: { type: 'object', properties: { price: { type: 'number' } } },
    });
    const parsed = result.json as { ok: boolean; agentId: string; name: string; systemPrompt: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.agentId).toBe(AGENT_ID);
    expect(parsed.name).toBe(
      '<untrusted-content source="browserbase:create_agent:agent.name">Acme pricing extractor</untrusted-content>',
    );
    expect(parsed.systemPrompt).toContain('<untrusted-content');
  });

  it('create_agent maps upstream 400 validation to VALIDATION_FAILED', async () => {
    const client = await makeClient();
    const result = await client.callTool('create_agent', { name: 'trigger-400' });
    expect(result.isError).toBe(true);
    const parsed = result.json as { code: string; error: string };
    expect(parsed.code).toBe('VALIDATION_FAILED');
    expect(parsed.error).toContain('body/name');
  });

  it('list_agents returns cursor pagination', async () => {
    const client = await makeClient();
    const result = await client.callTool('list_agents', { limit: 20 });
    const parsed = result.json as { ok: boolean; agents: unknown[]; next_cursor: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.next_cursor).toBe('agents_page_2');
  });

  it('list_agents coerces ISO date strings for start_at/end_at', async () => {
    const client = await makeClient();
    const result = await client.callTool('list_agents', { start_at: '2026-01-01', end_at: 1780000000000 });
    expect(result.isError).toBeFalsy();
    expect((result.json as { ok: boolean }).ok).toBe(true);
  });

  it('list_agents rejects ambiguous Unix-seconds strings', async () => {
    const client = await makeClient();
    const result = await client.callTool('list_agents', { start_at: '1735689600' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('epoch milliseconds');
  });

  it('get_agent / update_agent / delete_agent happy paths', async () => {
    const client = await makeClient();

    const got = await client.callTool('get_agent', { agent_id: AGENT_ID });
    expect((got.json as { ok: boolean; agentId: string }).agentId).toBe(AGENT_ID);

    const updated = await client.callTool('update_agent', { agent_id: AGENT_ID, name: 'Renamed agent' });
    const updatedJson = updated.json as { ok: boolean; name: string };
    expect(updatedJson.ok).toBe(true);
    expect(updatedJson.name).toContain('Renamed agent');

    const deleted = await client.callTool('delete_agent', { agent_id: AGENT_ID });
    expect((deleted.json as { ok: boolean; message: string }).message).toContain('unaffected');
  });

  it('get_agent 404 maps to NOT_FOUND', async () => {
    const client = await makeClient();
    const result = await client.callTool('get_agent', { agent_id: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect((result.json as { code: string }).code).toBe('NOT_FOUND');
  });

  it('create_context returns encryption metadata and a save-the-id message', async () => {
    const client = await makeClient();
    const result = await client.callTool('create_context', { name: 'Acme portal login' });
    const parsed = result.json as { ok: boolean; id: string; cipherAlgorithm: string; message: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe(CONTEXT_ID);
    expect(parsed.cipherAlgorithm).toBe('aes-256-gcm');
    expect(parsed.message).toContain('cannot be listed');
  });

  it('get_context wraps the user-authored name; delete_context succeeds', async () => {
    const client = await makeClient();
    const got = await client.callTool('get_context', { context_id: CONTEXT_ID });
    expect((got.json as { name: string }).name).toContain('<untrusted-content');

    const deleted = await client.callTool('delete_context', { context_id: CONTEXT_ID });
    expect((deleted.json as { ok: boolean }).ok).toBe(true);
  });

  it('delete_context 404 maps to NOT_FOUND', async () => {
    const client = await makeClient();
    const result = await client.callTool('delete_context', { context_id: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect((result.json as { code: string }).code).toBe('NOT_FOUND');
  });
});
