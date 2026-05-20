import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from '../helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

const RETELL_API_BASE = 'https://api.retellai.com';

/**
 * Integration coverage for the stale-prompt warning emitted by create_phone_call.
 * The helper itself is unit-tested in test/precall-checks.test.ts — these tests
 * verify the warning is wired into the response payload returned over MCP.
 */
describe('create_phone_call — dynamic-variable warnings', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('does not emit warnings when no dynamic variables are passed', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_phone_call',
      arguments: {
        from_number: '+14155551234',
        to_number: '+14155555678',
        override_agent_id: 'agent_test_123',
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.warnings).toBeUndefined();
  });

  it('emits warnings when passed variables are not referenced in the live prompt', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_phone_call',
      arguments: {
        from_number: '+14155551234',
        to_number: '+14155555678',
        override_agent_id: 'agent_test_123',
        retell_llm_dynamic_variables: {
          top_action_items: 'item 1, item 2, item 3',
        },
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.call_id).toBe('call_phone_001');
    expect(parsed.warnings).toBeInstanceOf(Array);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('top_action_items');
    expect(parsed.warnings[0]).toContain('update_retell_llm');
  });

  it('does not emit warnings when the live prompt references the passed variables', async () => {
    mswServer.use(
      http.get(`${RETELL_API_BASE}/get-retell-llm/:llmId`, ({ request, params }) => {
        const auth = request.headers.get('authorization');
        if (!auth || auth.split(' ')[1] !== MOCK_API_KEY) {
          return HttpResponse.json({ error_message: 'Unauthorized' }, { status: 401 });
        }
        return HttpResponse.json({
          llm_id: params.llmId,
          general_prompt: 'Calling {{customer_name}} about their order.',
          model: 'gpt-5.5',
        });
      }),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_phone_call',
      arguments: {
        from_number: '+14155551234',
        to_number: '+14155555678',
        override_agent_id: 'agent_test_123',
        retell_llm_dynamic_variables: { customer_name: 'Jane' },
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.warnings).toBeUndefined();
  });

  it('still places the call even when the warning lookup fails', async () => {
    mswServer.use(
      http.get(`${RETELL_API_BASE}/get-agent/:agentId`, () =>
        HttpResponse.json({ error_message: 'Internal error' }, { status: 500 }),
      ),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_phone_call',
      arguments: {
        from_number: '+14155551234',
        to_number: '+14155555678',
        override_agent_id: 'agent_test_123',
        retell_llm_dynamic_variables: { customer_name: 'Jane' },
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.call_id).toBe('call_phone_001');
    expect(parsed.warnings).toBeUndefined();
  });

  it('resolves agent via phone number binding when no override_agent_id is passed', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_phone_call',
      arguments: {
        from_number: '+14155551234',
        to_number: '+14155555678',
        retell_llm_dynamic_variables: { top_action_items: 'item 1' },
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.warnings).toBeInstanceOf(Array);
    expect(parsed.warnings[0]).toContain('agent_test_123');
    expect(parsed.warnings[0]).toContain('top_action_items');
  });
});
