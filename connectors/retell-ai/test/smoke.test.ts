import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from './helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const EXPECTED_TOOLS = [
  'add_knowledge_base_sources',
  'configure_retell_api_key',
  'create_agent',
  'create_batch_call',
  'create_knowledge_base',
  'create_phone_call',
  'create_retell_llm',
  'create_web_call',
  'delete_agent',
  'delete_phone_number',
  'delete_retell_llm',
  'get_agent',
  'get_agent_versions',
  'get_call',
  'get_knowledge_base',
  'get_phone_number',
  'get_retell_llm',
  'list_agents',
  'list_calls',
  'list_knowledge_bases',
  'list_phone_numbers',
  'list_retell_llms',
  'list_voices',
  'publish_agent',
  'stop_call',
  'update_agent',
  'update_phone_number',
  'update_retell_llm',
];

describe('Smoke test — Retell AI MCP server', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('should register all 28 tools via MCP protocol', async () => {
    mswServer.use(...createRetellHandlers());

    testClient = await createTestClient({
      env: {
        RETELL_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map(t => t.name).sort();

    expect(toolsResult.tools).toHaveLength(28);
    expect(toolNames).toEqual(EXPECTED_TOOLS);
  });

  it('should have non-empty descriptions for all tools', async () => {
    mswServer.use(...createRetellHandlers());

    testClient = await createTestClient({
      env: {
        RETELL_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    for (const tool of toolsResult.tools) {
      expect(tool.description, `Tool ${tool.name} should have a description`).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(10);
    }
  });

  it('should have annotations on all tools', async () => {
    mswServer.use(...createRetellHandlers());

    testClient = await createTestClient({
      env: {
        RETELL_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();

    const readOnlyTools = [
      'get_agent', 'list_agents', 'get_call', 'list_calls',
      'get_retell_llm', 'list_retell_llms', 'list_voices', 'list_phone_numbers',
      'get_agent_versions', 'get_phone_number',
      'list_knowledge_bases', 'get_knowledge_base',
    ];

    const destructiveTools = [
      'update_agent', 'update_retell_llm',
      'create_phone_call', 'create_web_call',
      'create_agent', 'create_retell_llm',
      'configure_retell_api_key',
      'stop_call', 'publish_agent', 'update_phone_number',
      'create_batch_call',
      'create_knowledge_base', 'add_knowledge_base_sources',
      'delete_agent', 'delete_retell_llm', 'delete_phone_number',
    ];

    for (const tool of toolsResult.tools) {
      expect(tool.annotations, `Tool ${tool.name} should have annotations`).toBeDefined();
      expect(typeof tool.annotations!.readOnlyHint).toBe('boolean');
      expect(typeof tool.annotations!.destructiveHint).toBe('boolean');

      if (readOnlyTools.includes(tool.name)) {
        expect(tool.annotations!.readOnlyHint, `${tool.name} should be readOnly`).toBe(true);
        expect(tool.annotations!.destructiveHint, `${tool.name} should not be destructive`).toBe(false);
      }

      if (destructiveTools.includes(tool.name)) {
        expect(tool.annotations!.destructiveHint, `${tool.name} should be destructive`).toBe(true);
        expect(tool.annotations!.readOnlyHint, `${tool.name} should not be readOnly`).toBe(false);
      }
    }
  });

  it('should have valid inputSchema for all tools', async () => {
    mswServer.use(...createRetellHandlers());

    testClient = await createTestClient({
      env: {
        RETELL_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    for (const tool of toolsResult.tools) {
      expect(tool.inputSchema, `Tool ${tool.name} should have inputSchema`).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});
