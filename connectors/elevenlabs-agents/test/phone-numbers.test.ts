import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsAgentsHandlers, MOCK_API_KEY } from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('phone number tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists phone numbers and gets one number by ID', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const listed = await testClient.callTool('list_phone_numbers', { page_size: 1 });
    expect(listed.isError).toBeFalsy();
    expect(listed.json.count).toBe(1);

    const single = await testClient.callTool('get_phone_number', { phone_number_id: 'pn_custom_456' });
    expect(single.isError).toBeFalsy();
    expect(single.json.phone_number.phone_number_id).toBe('pn_custom_456');
  });
});
