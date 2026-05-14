import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsHandlers } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 8 tools with correct names', async () => {
    mswServer.use(...createElevenLabsHandlers());

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(8);
    expect(toolNames).toEqual([
      'configure_elevenlabs_api_key',
      'create_music_plan',
      'generate_music',
      'generate_music_from_plan',
      'generate_sound_effect',
      'generate_speech',
      'list_voices',
      'transcribe_audio',
    ]);
  });
});

describe('Spawned stdio smoke test', () => {
  it('lists 8 tools from built dist/index.js', async () => {
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
      expect(toolsResult.tools).toHaveLength(8);
    } finally {
      await client.close();
    }
  });
});
