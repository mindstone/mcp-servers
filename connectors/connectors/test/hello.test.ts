import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('Humaans hello world tool', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup() {
    // No API key — hello world must work without auth
    testClient = await createTestClient({
      env: {
        HUMAANS_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  it('humaans_hello_world returns greeting', async () => {
    await setup();
    const result = await testClient.callTool('humaans_hello_world', {});
    const json = result.json as { ok: boolean; message: string };

    expect(result.isError).toBeFalsy();
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Hello from Humaans MCP!');
  });

  it('humaans_hello_world appears in tool list', async () => {
    await setup();
    const toolsResult = await testClient.client.listTools();
    const names = toolsResult.tools.map((t) => t.name);
    expect(names).toContain('humaans_hello_world');
  });
});
