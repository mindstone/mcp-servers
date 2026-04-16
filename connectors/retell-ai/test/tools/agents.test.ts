import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from '../helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

describe('Agent tools — Retell AI', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('list_agents returns agent array with ok:true', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({ name: 'list_agents', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.agents).toBeInstanceOf(Array);
    expect(parsed.agents.length).toBeGreaterThan(0);
    expect(parsed.agents[0].agent_id).toBe('agent_test_123');
  });

  it('get_agent returns agent details', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_agent',
      arguments: { agent_id: 'agent_test_123' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe('agent_test_123');
    expect(parsed.agent_name).toBe('Test Agent');
  });

  it('create_agent sends correct payload and returns new agent', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_agent',
      arguments: {
        agent_name: 'New Test Agent',
        voice_id: 'voice_test_456',
        language: 'en-US',
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe('agent_new_001');
    expect(parsed.agent_name).toBe('New Test Agent');
  });

  it('update_agent sends correct payload', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'update_agent',
      arguments: {
        agent_id: 'agent_test_123',
        agent_name: 'Updated Agent',
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.agent_name).toBe('Updated Agent');
  });
});
