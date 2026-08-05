import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsAgentsHandlers, MOCK_API_KEY } from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const EXPECTED_TOOL_NAMES = [
  'add_knowledge_base_document',
  'cancel_batch_call',
  'configure_elevenlabs_agents_api_key',
  'create_agent',
  'delete_agent',
  'delete_knowledge_base_document',
  'delete_phone_number',
  'duplicate_agent',
  'get_agent',
  'get_batch_call',
  'get_conversation',
  'get_conversation_audio',
  'get_knowledge_base_doc',
  'get_phone_number',
  'import_phone_number',
  'list_agents',
  'list_batch_calls',
  'list_conversations',
  'list_knowledge_base_docs',
  'list_phone_numbers',
  'make_outbound_call',
  'retry_batch_call',
  'simulate_conversation',
  'submit_batch_call',
  'update_agent',
  'update_phone_number',
].sort();

const EXPECTED_ANNOTATIONS: Record<
  string,
  { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint?: boolean }
> = {
  add_knowledge_base_document: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  cancel_batch_call: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  configure_elevenlabs_agents_api_key: { readOnlyHint: false, destructiveHint: true },
  create_agent: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  delete_agent: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  delete_knowledge_base_document: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  delete_phone_number: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  duplicate_agent: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  get_agent: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_batch_call: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_conversation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_conversation_audio: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_knowledge_base_doc: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  get_phone_number: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  import_phone_number: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  list_agents: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_batch_calls: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_conversations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_knowledge_base_docs: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  list_phone_numbers: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  make_outbound_call: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  retry_batch_call: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  simulate_conversation: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  submit_batch_call: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  update_agent: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  update_phone_number: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

describe('Smoke test — ElevenLabs Agents tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 26 tools with correct names', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name).sort();

    expect(toolsResult.tools).toHaveLength(26);
    expect(toolNames).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('has the complete D-ANNOTATIONS table for Stage 7 tools', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    expect(Object.keys(EXPECTED_ANNOTATIONS).sort()).toEqual(EXPECTED_TOOL_NAMES);

    for (const tool of toolsResult.tools) {
      expect(tool.annotations, `Tool ${tool.name} should have annotations`).toBeDefined();
      expect(tool.annotations!.readOnlyHint, `${tool.name} readOnlyHint`).toBe(
        EXPECTED_ANNOTATIONS[tool.name].readOnlyHint,
      );
      expect(tool.annotations!.destructiveHint, `${tool.name} destructiveHint`).toBe(
        EXPECTED_ANNOTATIONS[tool.name].destructiveHint,
      );
      expect(tool.annotations!.idempotentHint, `${tool.name} idempotentHint`).toBe(
        EXPECTED_ANNOTATIONS[tool.name].idempotentHint,
      );
    }
  });

  it('every tool description includes FREE/COST marker, WHEN TO USE, RELATED TOOLS, and EXAMPLE', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    for (const tool of toolsResult.tools) {
      const desc = tool.description ?? '';
      expect(desc, `${tool.name} description`).toMatch(/COST:|FREE/);
      expect(desc, `${tool.name} WHEN TO USE`).toContain('WHEN TO USE');
      expect(desc, `${tool.name} RELATED TOOLS`).toContain('RELATED TOOLS');
      expect(desc, `${tool.name} EXAMPLE`).toContain('EXAMPLE');
    }
  });
});

describe('Spawned stdio smoke test', () => {
  it('lists 26 tools from built dist/index.js', async () => {
    const { createStdioTestClient } = await import('@mindstone/mcp-test-harness');
    const { join } = await import('path');

    const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
    const client = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: {
        ELEVENLABS_API_KEY: 'mcp-test-elevenlabs-agents-key',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const toolsResult = await client.client.listTools();
      expect(toolsResult.tools).toHaveLength(26);
    } finally {
      await client.close();
    }
  });
});
