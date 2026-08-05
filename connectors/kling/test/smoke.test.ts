import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createKlingHandlers } from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 7 tools with correct names', async () => {
    mswServer.use(...createKlingHandlers());

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: 'test-access-key',
        KLING_SECRET_KEY: 'test-secret-key-at-least-32-chars-long',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(7);
    expect(toolNames).toEqual([
      'check_kling_task',
      'configure_kling_api_keys',
      'download_kling_video',
      'extend_kling_video',
      'generate_kling_image_to_video',
      'generate_kling_lip_sync',
      'generate_kling_video',
    ]);
  });
});
