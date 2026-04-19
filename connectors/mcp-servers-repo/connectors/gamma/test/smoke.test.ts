import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createGammaHandlers } from './helpers/gamma-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/gamma-data.js';

describe('Smoke test — tool registration', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 6 tools with correct names', async () => {
    mswServer.use(...createGammaHandlers());

    testClient = await createTestClient({
      env: {
        GAMMA_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolsResult.tools).toHaveLength(6);
    expect(toolNames).toEqual([
      'configure_gamma_api_key',
      'gamma_create_from_template',
      'gamma_generate',
      'gamma_get_status',
      'gamma_list_folders',
      'gamma_list_themes',
    ]);
  });
});

describe('Spawned stdio smoke test', () => {
  it('lists 6 tools from built dist/index.js', async () => {
    const { createStdioTestClient } = await import('@mindstone-engineering/mcp-test-harness');
    const { join } = await import('path');

    const distPath = join(import.meta.dirname, '..', 'dist', 'index.js');
    const client = await createStdioTestClient({
      command: 'node',
      args: [distPath],
      env: {
        GAMMA_API_KEY: 'mcp-test-gamma-key',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    try {
      const toolsResult = await client.client.listTools();
      expect(toolsResult.tools).toHaveLength(6);
    } finally {
      await client.close();
    }
  });
});
