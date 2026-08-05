import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createRunwayHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

const EXPECTED_TOOLS = [
  'cancel_runway_task',
  'character_performance',
  'configure_runway_api_key',
  'create_custom_voice',
  'delete_custom_voice',
  'download_runway_output',
  'dub_audio',
  'generate_image',
  'generate_sound_effect',
  'generate_speech',
  'generate_video_from_image',
  'generate_video_from_text',
  'generate_video_from_video',
  'get_runway_balance',
  'isolate_voice',
  'list_custom_voices',
  'preview_voice',
  'query_credit_usage',
  'swap_voice',
  'upload_media',
  'upscale_video',
  'wait_for_runway_task',
  'check_runway_task',
].sort();

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 23 tools with correct names', async () => {
    mswServer.use(...createRunwayHandlers());

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(23);
    expect(toolNames).toEqual(EXPECTED_TOOLS);
  });
});

describe('Spawned stdio smoke test', () => {
  it('lists 23 tools from built dist/index.js', async () => {
    const { createStdioTestClient } = await import('@mindstone/mcp-test-harness');
    const { join } = await import('path');

    const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
    const client = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: {
        RUNWAYML_API_SECRET: 'mcp-test-runway-key',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const toolsResult = await client.client.listTools();
      expect(toolsResult.tools).toHaveLength(23);
    } finally {
      await client.close();
    }
  });
});
