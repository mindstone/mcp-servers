import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createAddAgentToolCapturingHandler,
  createAddAgentToolEchoHandler,
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

  it('envelopes advanced_config fragments in the flattened tool_config reflection', async () => {
    // Regression: advanced_config deep-merges into tool_config before the POST,
    // so the API reflection carries the fragment at tool_config.custom with no
    // `advanced_config` ancestor name. Ancestor-name-based trust therefore let a
    // two-word, alphabet-conforming string such as DELETE_DATA sit literally
    // under the structural-looking `status` key and reach the model unenveloped.
    const { handler, captured } = createAddAgentToolEchoHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('add_agent_tool', {
      type: 'client',
      name: 'open_help_center',
      description: 'Open the help center in the app.',
      advanced_config: { custom: { status: 'DELETE_DATA' } },
    });

    expect(result.isError).toBeFalsy();
    // The fragment went upstream flattened: no `advanced_config` key on the wire.
    expect(captured.body).toEqual({
      tool_config: {
        type: 'client',
        name: 'open_help_center',
        description: 'Open the help center in the app.',
        custom: { status: 'DELETE_DATA' },
      },
    });

    const config = result.json.tool.tool_config;
    expect(config.type).toBe('client');
    expect(config.custom.status).toContain('<untrusted-content');
    expect(config.custom.status).toContain('DELETE_DATA');
    expect(config.custom.status).toContain('elevenlabs-agents:add_agent_tool:tool_config:custom:status');
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

  // No msw handlers are registered in these tests: a rejection must happen
  // before any upstream call, so a validation miss would surface as a fetch
  // failure instead of the asserted error.
  it.each([
    'http://169.254.169.254/latest/meta-data',
    'https://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:8080/hook',
    'https://10.0.0.8/hook',
    'https://192.168.0.1/hook',
    'https://[::1]/hook',
    'https://localhost/hook',
    'http://example.com/hook',
  ])('add_agent_tool rejects dangerous webhook url %s before any upstream call', async (url) => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('add_agent_tool', {
      type: 'webhook',
      name: 'check_order_status',
      description: 'Look up an order by ID.',
      url,
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ ok: false, code: 'INVALID_URL' });
  });

  it('rejects advanced_config that overrides the validated type to smuggle in a webhook', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('add_agent_tool', {
      type: 'client',
      name: 'safe_name',
      description: 'safe',
      advanced_config: {
        type: 'webhook',
        api_schema: { url: 'http://169.254.169.254/latest/meta-data', method: 'TRACE' },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
    expect(result.json.error).toContain('"type"');
  });

  it('rejects advanced_config that overrides the first-class webhook url or method', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('add_agent_tool', {
      type: 'webhook',
      name: 'check_order_status',
      description: 'Look up an order by ID.',
      url: 'https://example.com/api/order',
      advanced_config: { api_schema: { url: 'https://example.org/other' } },
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
    expect(result.json.error).toContain('api_schema.url');
  });

  it('rejects api_schema inside advanced_config for a client tool', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('add_agent_tool', {
      type: 'client',
      name: 'open_help_center',
      description: 'Open the help center in the app.',
      advanced_config: { api_schema: { request_headers: { 'X-Test': '1' } } },
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
    expect(result.json.error).toContain('api_schema');
  });

  it('deep-merges non-protected advanced_config fragments into the webhook api_schema', async () => {
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
      advanced_config: {
        api_schema: {
          request_headers: { 'X-Custom': 'yes' },
          request_body_schema: { type: 'object', properties: { id: { type: 'string' } } },
        },
        response_timeout_secs: 20,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      tool_config: {
        type: 'webhook',
        name: 'check_order_status',
        description: 'Look up an order by ID.',
        api_schema: {
          url: 'https://example.com/api/order',
          method: 'POST',
          request_headers: { 'X-Custom': 'yes' },
          request_body_schema: { type: 'object', properties: { id: { type: 'string' } } },
        },
        response_timeout_secs: 20,
      },
    });
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
