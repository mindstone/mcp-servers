import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsHandlers } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

const EXPECTED_TOOL_NAMES = [
  'check_subscription',
  'clone_voice',
  'configure_elevenlabs_api_key',
  'create_music_plan',
  'delete_voice',
  'forced_alignment',
  'generate_music',
  'generate_music_from_plan',
  'generate_sound_effect',
  'generate_speech',
  'get_voice',
  'isolate_audio',
  'list_models',
  'list_voices',
  'search_shared_voices',
  'speech_to_speech',
  'transcribe_audio',
].sort();

/** Complete D-ANNOTATIONS table for all 17 tools (post-Stage 3). */
const EXPECTED_ANNOTATIONS: Record<string, { readOnlyHint: boolean; destructiveHint: boolean }> = {
  check_subscription: { readOnlyHint: true, destructiveHint: false },
  clone_voice: { readOnlyHint: false, destructiveHint: true },
  configure_elevenlabs_api_key: { readOnlyHint: false, destructiveHint: true },
  create_music_plan: { readOnlyHint: true, destructiveHint: false },
  delete_voice: { readOnlyHint: false, destructiveHint: true },
  forced_alignment: { readOnlyHint: true, destructiveHint: false },
  generate_music: { readOnlyHint: false, destructiveHint: false },
  generate_music_from_plan: { readOnlyHint: false, destructiveHint: false },
  generate_sound_effect: { readOnlyHint: false, destructiveHint: false },
  generate_speech: { readOnlyHint: false, destructiveHint: false },
  get_voice: { readOnlyHint: true, destructiveHint: false },
  isolate_audio: { readOnlyHint: false, destructiveHint: false },
  list_models: { readOnlyHint: true, destructiveHint: false },
  list_voices: { readOnlyHint: true, destructiveHint: false },
  search_shared_voices: { readOnlyHint: true, destructiveHint: false },
  speech_to_speech: { readOnlyHint: false, destructiveHint: false },
  transcribe_audio: { readOnlyHint: true, destructiveHint: false },
};

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 17 tools with correct names', async () => {
    mswServer.use(...createElevenLabsHandlers());

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(17);
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

    expect(Object.keys(EXPECTED_ANNOTATIONS).sort()).toEqual(EXPECTED_TOOL_NAMES);

    for (const tool of toolsResult.tools) {
      expect(tool.annotations, `Tool ${tool.name} should have annotations`).toBeDefined();
      expect(typeof tool.annotations!.readOnlyHint).toBe('boolean');
      expect(typeof tool.annotations!.destructiveHint).toBe('boolean');

      const expected = EXPECTED_ANNOTATIONS[tool.name];
      expect(expected, `Missing EXPECTED_ANNOTATIONS entry for ${tool.name}`).toBeDefined();
      expect(tool.annotations!.readOnlyHint, `${tool.name} readOnlyHint`).toBe(expected.readOnlyHint);
      expect(tool.annotations!.destructiveHint, `${tool.name} destructiveHint`).toBe(expected.destructiveHint);
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
  it('lists 17 tools from built dist/index.js', async () => {
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
      expect(toolsResult.tools).toHaveLength(17);
    } finally {
      await client.close();
    }
  });
});
