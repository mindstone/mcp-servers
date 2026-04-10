import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createNanoBananaHandlers } from './helpers/nano-banana-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/nano-banana-data.js';

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 3 tools with correct names', async () => {
    mswServer.use(...createNanoBananaHandlers());

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(3);
    expect(toolNames).toEqual([
      'configure_nano_banana_api_key',
      'nano_banana_edit',
      'nano_banana_generate',
    ]);
  });
});

describe('Spawned stdio smoke test', () => {
  it('lists 3 tools from built dist/index.js', async () => {
    const { createStdioTestClient } = await import('@mindstone-engineering/mcp-test-harness');
    const { join } = await import('path');

    const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
    const client = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: {
        GEMINI_API_KEY: 'mcp-test-nano-banana-key',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const toolsResult = await client.client.listTools();
      expect(toolsResult.tools).toHaveLength(3);
    } finally {
      await client.close();
    }
  });
});
