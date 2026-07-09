import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsAgentsHandlers, MOCK_API_KEY } from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const EXPECTED_TOOL_NAMES = [
  'configure_elevenlabs_agents_api_key',
  'get_agent',
  'get_conversation',
  'get_conversation_audio',
  'get_knowledge_base_doc',
  'get_phone_number',
  'list_agents',
  'list_conversations',
  'list_knowledge_base_docs',
  'list_phone_numbers',
].sort();

const EXPECTED_ANNOTATIONS: Record<string, { readOnlyHint: boolean; destructiveHint: boolean }> = {
  configure_elevenlabs_agents_api_key: { readOnlyHint: false, destructiveHint: true },
  get_agent: { readOnlyHint: true, destructiveHint: false },
  get_conversation: { readOnlyHint: true, destructiveHint: false },
  get_conversation_audio: { readOnlyHint: true, destructiveHint: false },
  get_knowledge_base_doc: { readOnlyHint: true, destructiveHint: false },
  get_phone_number: { readOnlyHint: true, destructiveHint: false },
  list_agents: { readOnlyHint: true, destructiveHint: false },
  list_conversations: { readOnlyHint: true, destructiveHint: false },
  list_knowledge_base_docs: { readOnlyHint: true, destructiveHint: false },
  list_phone_numbers: { readOnlyHint: true, destructiveHint: false },
};

describe('Smoke test — ElevenLabs Agents tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 10 Stage 5 tools with correct names', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name).sort();

    expect(toolsResult.tools).toHaveLength(10);
    expect(toolNames).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('has the complete D-ANNOTATIONS table for Stage 5 tools', async () => {
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
  it('lists 10 tools from built dist/index.js', async () => {
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
      expect(toolsResult.tools).toHaveLength(10);
    } finally {
      await client.close();
    }
  });
});
