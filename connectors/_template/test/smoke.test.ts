import { describe, it, expect, afterAll } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';

describe('Smoke test — scaffold template verification', () => {
  let testClient: McpTestClient;

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('should list all registered tools via MCP protocol', async () => {
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map(t => t.name).sort();

    // Template registers 2 example tools
    expect(toolsResult.tools).toHaveLength(2);
    expect(toolNames).toEqual([
      'configure_CONNECTOR_NAME_api_key',
      'list_CONNECTOR_NAME_resources',
    ]);
  });

  it('should call a tool and receive a valid response', async () => {
    if (!testClient) {
      testClient = await createInMemoryTestClient({
        createServer,
        env: {
          MCP_HOST_BRIDGE_STATE: '',
        },
      });
    }

    const result = await testClient.callTool('list_CONNECTOR_NAME_resources', { limit: 10 });
    expect(result.isError).toBeFalsy();
    expect(result.json).toEqual({
      ok: true,
      resources: [],
      total: 0,
    });
  });

  it('should validate input with Zod schema', async () => {
    if (!testClient) {
      testClient = await createInMemoryTestClient({
        createServer,
        env: {
          MCP_HOST_BRIDGE_STATE: '',
        },
      });
    }

    // Calling configure with an empty api_key should fail Zod validation
    const result = await testClient.callTool('configure_CONNECTOR_NAME_api_key', { api_key: '' });
    expect(result.isError).toBe(true);
  });
});
