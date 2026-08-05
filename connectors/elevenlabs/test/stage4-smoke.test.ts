import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsHandlers } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

const STAGE4_TOOL_NAMES = [
  'create_dubbing',
  'create_voice_from_preview',
  'delete_dubbing',
  'design_voice',
  'download_dubbed_audio',
  'get_dubbing',
  'text_to_dialogue',
].sort();

describe('Stage 4 smoke — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers all seven Stage 4 tools', async () => {
    mswServer.use(...createElevenLabsHandlers());

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);

    for (const name of STAGE4_TOOL_NAMES) {
      expect(toolNames, `missing ${name}`).toContain(name);
    }
    expect(toolsResult.tools).toHaveLength(31);
  });
});
