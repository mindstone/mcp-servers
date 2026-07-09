import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsHandlers } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

const EXPECTED_TOOL_NAMES = [
  'check_subscription',
  'configure_elevenlabs_api_key',
  'create_music_plan',
  'generate_music',
  'generate_music_from_plan',
  'generate_sound_effect',
  'generate_speech',
  'get_voice',
  'list_models',
  'list_voices',
  'search_shared_voices',
  'transcribe_audio',
].sort();

const READ_ONLY_TOOLS = [
  'check_subscription',
  'create_music_plan',
  'get_voice',
  'list_models',
  'list_voices',
  'search_shared_voices',
  'transcribe_audio',
];

const DESTRUCTIVE_TOOLS = ['configure_elevenlabs_api_key'];

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 12 tools with correct names', async () => {
    mswServer.use(...createElevenLabsHandlers());

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(12);
    expect(toolNames).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('should have annotations on all tools (D-ANNOTATIONS mechanical guard)', async () => {
    mswServer.use(...createElevenLabsHandlers());

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();

    for (const tool of toolsResult.tools) {
      expect(tool.annotations, `Tool ${tool.name} should have annotations`).toBeDefined();
      expect(typeof tool.annotations!.readOnlyHint).toBe('boolean');
      expect(typeof tool.annotations!.destructiveHint).toBe('boolean');

      if (READ_ONLY_TOOLS.includes(tool.name)) {
        expect(tool.annotations!.readOnlyHint, `${tool.name} should be readOnly`).toBe(true);
        expect(tool.annotations!.destructiveHint, `${tool.name} should not be destructive`).toBe(false);
      }

      if (DESTRUCTIVE_TOOLS.includes(tool.name)) {
        expect(tool.annotations!.destructiveHint, `${tool.name} should be destructive`).toBe(true);
        expect(tool.annotations!.readOnlyHint, `${tool.name} should not be readOnly`).toBe(false);
      }
    }
  });

  it('every tool description includes COST/FREE marker, WHEN TO USE, and RELATED TOOLS', async () => {
    mswServer.use(...createElevenLabsHandlers());

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
  it('lists 12 tools from built dist/index.js', async () => {
    const { createStdioTestClient } = await import('@mindstone/mcp-test-harness');
    const { join } = await import('path');

    const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
    const client = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: {
        ELEVENLABS_API_KEY: 'mcp-test-elevenlabs-key',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const toolsResult = await client.client.listTools();
      expect(toolsResult.tools).toHaveLength(12);
    } finally {
      await client.close();
    }
  });
});
