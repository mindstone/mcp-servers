import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsAgentsHandlers, MOCK_API_KEY } from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('agents tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists agents with pagination metadata', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_agents', { page_size: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.json.count).toBe(1);
    expect(result.json.next_cursor).toBe('cursor_agents_2');
  });

  it('gets a single agent object', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_agent', { agent_id: 'agent_custom_456' });
    expect(result.isError).toBeFalsy();
    expect(result.json.agent.agent_id).toBe('agent_custom_456');
  });
});
