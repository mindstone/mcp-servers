import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from './helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('Error handling — Retell AI', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('returns structured error for 401 Unauthorized', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: 'wrong-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_agents',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('HTTP_401');
    expect(parsed.resolution).toContain('Authentication failed');
  });

  it('returns structured error for 404 Not Found', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_agent',
      arguments: { agent_id: 'nonexistent' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('HTTP_404');
    expect(parsed.resolution).toContain('Resource not found');
  });

  it('returns structured error for 500 Server Error', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'get_agent',
      arguments: { agent_id: 'trigger-500' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('HTTP_500');
  });

  it('returns setup guidance when API key not configured', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_agents',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('AUTH_REQUIRED');
    expect(parsed.resolution).toContain('configure_retell_api_key');
  });

  it('server stays alive after error — subsequent calls succeed', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    // First: cause an error
    const errorResult = await testClient.client.callTool({
      name: 'get_agent',
      arguments: { agent_id: 'nonexistent' },
    });
    const errorText = (errorResult.content as Array<{ type: string; text: string }>)[0].text;
    const errorParsed = JSON.parse(errorText);
    expect(errorParsed.ok).toBe(false);

    // Second: verify server still works
    const successResult = await testClient.client.callTool({
      name: 'list_agents',
      arguments: {},
    });
    const successText = (successResult.content as Array<{ type: string; text: string }>)[0].text;
    const successParsed = JSON.parse(successText);
    expect(successParsed.ok).toBe(true);
    expect(successParsed.agents).toBeInstanceOf(Array);
  });
});
