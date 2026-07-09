import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsAgentsHandlers,
  createOutboundCallCapturingHandler,
  MOCK_API_KEY,
} from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('outbound call tool', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('resolves the phone-number provider and forwards dynamic variables', async () => {
    const { handler, captured } = createOutboundCallCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('make_outbound_call', {
      phone_number_id: 'pn_test_123',
      to_number: '+14155559876',
      dynamic_variables: {
        customer_name: 'Jane',
        account_note: 'Call after lunch.',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      agent_phone_number_id: 'pn_test_123',
      to_number: '+14155559876',
      conversation_initiation_client_data: {
        dynamic_variables: {
          customer_name: 'Jane',
          account_note: 'Call after lunch.',
        },
      },
    });
    expect(result.json.outbound_call.status).toBe('queued');
  });

  it('rejects non-E.164 to_number before any outbound request', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('make_outbound_call', {
      phone_number_id: 'pn_test_123',
      to_number: '415-555-9876',
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      ok: false,
      code: 'INVALID_PHONE_NUMBER',
    });
  });
});
