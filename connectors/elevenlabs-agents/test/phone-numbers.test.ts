import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsAgentsHandlers,
  createUpdatePhoneNumberCapturingHandler,
  MOCK_API_KEY,
} from './helpers/elevenlabs-agents-mock-server.js';
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

  it('updates a phone number label and assigned agent', async () => {
    const { handler, captured } = createUpdatePhoneNumberCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('update_phone_number', {
      phone_number_id: 'pn_test_123',
      label: 'Sales desk',
      agent_id: 'agent_updated_456',
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      label: 'Sales desk',
      agent_id: 'agent_updated_456',
    });
    expect(result.json.phone_number.label).toContain('<untrusted-content');
    expect(result.json.phone_number.assigned_agent_id).toBe('agent_updated_456');
  });
});
