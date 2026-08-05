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

  it('still places the call when the warning lookup fails, with an explicit degradation warning', async () => {
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
    // Fail-open but observable: the failed check surfaces as a warning.
    expect(parsed.warnings).toBeInstanceOf(Array);
    expect(parsed.warnings[0]).toContain('prompt check could not run');
  });

  it('completes the prompt check BEFORE the create-phone-call POST', async () => {
    // The LLM leg of the prompt check is held open; the create POST must not
    // fire until the check resolves — a warning computed after creation would
    // be unactionable for that call.
    let createAttempts = 0;
    let releaseLlm: () => void = () => undefined;
    const llmGate = new Promise<void>((resolve) => { releaseLlm = resolve; });
    mswServer.use(
      http.get(`${RETELL_API_BASE}/get-retell-llm/:llmId`, async ({ params }) => {
        await llmGate;
        return HttpResponse.json({
          llm_id: params.llmId,
          general_prompt: 'You are a helpful assistant.',
        });
      }),
      http.post(`${RETELL_API_BASE}/v2/create-phone-call`, () => {
        createAttempts += 1;
        return HttpResponse.json({
          call_id: 'call_phone_001',
          call_type: 'phone_call',
          agent_id: 'agent_test_123',
          status: 'registered',
          from_number: '+14155551234',
          to_number: '+14155555678',
        });
      }),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const pending = testClient.client.callTool({
      name: 'create_phone_call',
      arguments: {
        from_number: '+14155551234',
        to_number: '+14155555678',
        override_agent_id: 'agent_test_123',
        retell_llm_dynamic_variables: { customer_name: 'Jane' },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(createAttempts).toBe(0);

    releaseLlm();
    const result = await pending;
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(createAttempts).toBe(1);
    expect(parsed.warnings).toBeInstanceOf(Array);
  });

  it('completes the prompt check BEFORE the create-web-call POST', async () => {
    let createAttempts = 0;
    let releaseLlm: () => void = () => undefined;
    const llmGate = new Promise<void>((resolve) => { releaseLlm = resolve; });
    mswServer.use(
      http.get(`${RETELL_API_BASE}/get-retell-llm/:llmId`, async ({ params }) => {
        await llmGate;
        return HttpResponse.json({
          llm_id: params.llmId,
          general_prompt: 'You are a helpful assistant.',
        });
      }),
      http.post(`${RETELL_API_BASE}/v2/create-web-call`, () => {
        createAttempts += 1;
        return HttpResponse.json({
          call_id: 'call_web_001',
          web_call_link: 'https://app.retellai.com/call/call_web_001',
          access_token: 'tok_test',
          agent_id: 'agent_test_123',
          status: 'registered',
        });
      }),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const pending = testClient.client.callTool({
      name: 'create_web_call',
      arguments: {
        agent_id: 'agent_test_123',
        retell_llm_dynamic_variables: { customer_name: 'Jane' },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(createAttempts).toBe(0);

    releaseLlm();
    const result = await pending;
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(createAttempts).toBe(1);
    expect(parsed.warnings).toBeInstanceOf(Array);
  });

  it('resolves agent via phone number binding when no override_agent_id is passed', async () => {    mswServer.use(...createRetellHandlers());
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
