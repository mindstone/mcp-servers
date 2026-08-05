import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createAddAgentToolCapturingHandler,
  createElevenLabsAgentsHandlers,
  MOCK_API_KEY,
} from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('agent tool (workspace tool) tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists workspace tools with enveloped collaborator-authored fields', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_agent_tools', { page_size: 1 });

    expect(result.isError).toBeFalsy();
    expect(result.json.count).toBe(1);
    expect(result.json.next_cursor).toBe('cursor_tools_2');
    const tool = result.json.tools[0];
    expect(tool.id).toBe('tool_test_123');
    expect(tool.tool_config.name).toContain('<untrusted-content');
    expect(tool.tool_config.description).toContain('<untrusted-content');
  });

  it('adds a webhook tool with the api_schema mapping', async () => {
    const { handler, captured } = createAddAgentToolCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('add_agent_tool', {
      type: 'webhook',
      name: 'check_order_status',
      description: 'Look up an order by ID.',
      url: 'https://example.com/api/order',
      method: 'POST',
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      tool_config: {
        type: 'webhook',
        name: 'check_order_status',
        description: 'Look up an order by ID.',
        api_schema: { url: 'https://example.com/api/order', method: 'POST' },
      },
    });
    expect(result.json.tool.id).toBe('tool_test_123');
  });

  it('adds a client tool and deep-merges advanced_config last', async () => {
    const { handler, captured } = createAddAgentToolCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('add_agent_tool', {
      type: 'client',
      name: 'open_help_center',
      description: 'Open the help center in the app.',
      expects_response: false,
      advanced_config: { response_timeout_secs: 30 },
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      tool_config: {
        type: 'client',
        name: 'open_help_center',
        description: 'Open the help center in the app.',
        expects_response: false,
        response_timeout_secs: 30,
      },
    });
  });

  it('add_agent_tool rejects a webhook tool without a url before any upstream call', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('add_agent_tool', {
      type: 'webhook',
      name: 'check_order_status',
      description: 'Look up an order by ID.',
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
    expect(result.json.error).toContain('url');
  });

  it('agent tool list surfaces upstream errors', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_agent_tools', { cursor: 'trigger-429' });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  });
});
