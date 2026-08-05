import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from '../helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Voice & phone-number tools — Retell AI', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('list_voices returns voices with wrapped names', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({ name: 'list_voices', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.voices).toBeInstanceOf(Array);
    expect(parsed.count).toBe(1);
    expect(parsed.voices[0].voice_id).toBe('voice_test_456');
    // voice_name is external text → wrapped per AGENTS.md invariant #6 (FOX-3490).
    expect(parsed.voices[0].voice_name).toBe(
      '<untrusted-content source="retell:list_voices:voice_name">Sarah</untrusted-content>',
    );
  });

  it('list_phone_numbers returns numbers with bindings and wrapped nicknames', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({ name: 'list_phone_numbers', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.phone_numbers).toBeInstanceOf(Array);
    expect(parsed.count).toBe(1);
    expect(parsed.phone_numbers[0].phone_number).toBe('+14155551234');
    expect(parsed.phone_numbers[0].outbound_agents[0].agent_id).toBe('agent_test_123');
    expect(parsed.phone_numbers[0].nickname).toBe(
      '<untrusted-content source="retell:list_phone_numbers:nickname">Main Line</untrusted-content>',
    );
  });

  it('list_phone_numbers passes pagination params through', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_phone_numbers',
      arguments: { limit: 10, pagination_key: 'page_2' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.phone_numbers).toBeInstanceOf(Array);
  });

  it('get_phone_number returns one number with bindings', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_phone_number',
      arguments: { phone_number: '+14155551234' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.phone_number).toBe('+14155551234');
    expect(parsed.inbound_agents[0].weight).toBe(1);
    expect(parsed.nickname).toBe(
      '<untrusted-content source="retell:get_phone_number:nickname">Main Line</untrusted-content>',
    );
  });

  it('update_phone_number sends weighted agent bindings', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'update_phone_number',
      arguments: {
        phone_number: '+14155551234',
        outbound_agents: [{ agent_id: 'agent_test_123', agent_version: 1, weight: 1 }],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.phone_number).toBe('+14155551234');
    expect(parsed.outbound_agents[0].agent_version).toBe(1);
  });

  it('update_phone_number rejects a binding without weight', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'update_phone_number',
      arguments: {
        phone_number: '+14155551234',
        outbound_agents: [{ agent_id: 'agent_test_123' }],
      },
    });

    // Zod schema rejection happens before the handler runs; the SDK surfaces
    // it as an error result rather than the connector's JSON envelope.
    expect(result.isError).toBe(true);
  });

  it('update_phone_number rejects a weight outside 0-1', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'update_phone_number',
      arguments: {
        phone_number: '+14155551234',
        outbound_agents: [{ agent_id: 'agent_test_123', weight: 2 }],
      },
    });

    expect(result.isError).toBe(true);
  });

  it('delete_phone_number succeeds with ok:true', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'delete_phone_number',
      arguments: { phone_number: '+14155551234' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('+14155551234');
  });

  it('delete_phone_number rejects a malformed number before any API call', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'delete_phone_number',
      arguments: { phone_number: '415-555-1234' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('INVALID_PHONE_NUMBER');
  });

  it('delete_phone_number returns structured error for 404', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'delete_phone_number',
      arguments: { phone_number: '+19999999999' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('HTTP_404');
  });
});
