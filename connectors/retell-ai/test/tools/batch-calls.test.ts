import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from '../helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

const RETELL_API_BASE = 'https://api.retellai.com';

/**
 * Intercept every Retell request with a counter. Used by validation tests that
 * must prove ZERO requests reached the upstream API surface.
 */
function countUpstreamRequests(): { count: () => number } {
  let n = 0;
  mswServer.use(
    http.all(`${RETELL_API_BASE}/*`, () => {
      n += 1;
      return HttpResponse.json({ error_message: 'unexpected upstream request' }, { status: 500 });
    }),
  );
  return { count: () => n };
}

describe('Batch call tools — Retell AI', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('create_batch_call sends correct payload and returns batch id', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155551234',
        name: 'Reminder campaign',
        tasks: [
          { to_number: '+14155555678' },
          { to_number: '+14155559876', metadata: { row: 2 } },
        ],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.batch_call_id).toBe('batch_call_test_001');
    expect(parsed.total_task_count).toBe(2);
    expect(parsed.from_number).toBe('+14155551234');
    // name is external text → wrapped per AGENTS.md invariant #6 (FOX-3490).
    expect(parsed.name).toBe(
      '<untrusted-content source="retell:create_batch_call:name">Reminder campaign</untrusted-content>',
    );
  });

  it('create_batch_call coerces a date-string trigger_timestamp to epoch ms', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155551234',
        tasks: [{ to_number: '+14155555678' }],
        trigger_timestamp: '2026-01-01',
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.scheduled_timestamp).toBe(new Date('2026-01-01').getTime());
  });

  it('create_batch_call rejects a malformed to_number before any API call', async () => {
    mswServer.use(...createRetellHandlers());
    const upstream = countUpstreamRequests();
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155551234',
        tasks: [{ to_number: '415-555-5678' }],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('INVALID_PHONE_NUMBER');
    expect(parsed.error).toContain('tasks[0].to_number');
    expect(upstream.count()).toBe(0);
  });

  it('create_batch_call rejects a malformed from_number with zero upstream requests', async () => {
    mswServer.use(...createRetellHandlers());
    const upstream = countUpstreamRequests();
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '14155551234',
        tasks: [{ to_number: '+14155555678' }],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('INVALID_PHONE_NUMBER');
    expect(parsed.error).toContain('from_number');
    expect(upstream.count()).toBe(0);
  });

  it('create_batch_call validates every recipient before any API call', async () => {
    mswServer.use(...createRetellHandlers());
    const upstream = countUpstreamRequests();
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155551234',
        tasks: [
          { to_number: '+14155555678' },
          { to_number: '555-9876' },
          { to_number: 'not-a-number' },
        ],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('INVALID_PHONE_NUMBER');
    expect(parsed.error).toContain('tasks[1].to_number');
    expect(upstream.count()).toBe(0);
  });

  it('create_batch_call is annotated destructiveHint and not readOnly', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const { tools } = await testClient.client.listTools();
    const tool = tools.find((t) => t.name === 'create_batch_call');

    expect(tool).toBeDefined();
    expect(tool!.annotations!.destructiveHint).toBe(true);
    expect(tool!.annotations!.readOnlyHint).toBe(false);
  });

  it('create_batch_call runs the prompt check per effective agent (default + override)', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155551234',
        tasks: [
          { to_number: '+14155555678', retell_llm_dynamic_variables: { customer_name: 'Jane' } },
          {
            to_number: '+14155559876',
            override_agent_id: 'agent_override_9',
            retell_llm_dynamic_variables: { order_id: 'A1' },
          },
        ],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.warnings).toBeInstanceOf(Array);
    // The mock LLM prompt has no {{placeholders}}, so BOTH effective agents
    // produce their own warning: the phone number's default outbound agent and
    // the per-task override agent.
    const defaultWarning = parsed.warnings.find((w: string) => w.includes('customer_name'));
    const overrideWarning = parsed.warnings.find((w: string) => w.includes('order_id'));
    expect(defaultWarning).toBeDefined();
    expect(defaultWarning).toContain('agent_test_123');
    expect(overrideWarning).toBeDefined();
    expect(overrideWarning).toContain('agent_override_9');
  });

  it('create_batch_call completes the prompt check before creating the batch', async () => {
    const order: string[] = [];
    mswServer.use(
      http.get(`${RETELL_API_BASE}/get-phone-number/:phoneNumber`, () => {
        order.push('precall-check');
        return HttpResponse.json({
          phone_number: '+14155551234',
          outbound_agents: [{ agent_id: 'agent_test_123', agent_version: 1 }],
        });
      }),
      http.post(`${RETELL_API_BASE}/create-batch-call`, () => {
        order.push('create');
        return HttpResponse.json({
          batch_call_id: 'batch_call_test_001',
          from_number: '+14155551234',
          scheduled_timestamp: 1704067200000,
          total_task_count: 1,
        });
      }),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155551234',
        tasks: [{ to_number: '+14155555678', retell_llm_dynamic_variables: { customer_name: 'Jane' } }],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(order).toContain('precall-check');
    expect(order).toContain('create');
    expect(order.indexOf('precall-check')).toBeLessThan(order.indexOf('create'));
  });

  it('create_batch_call does not merge colliding (agent_id, version) group keys', async () => {
    // Regression: the grouping key used to be plain concatenation, so
    // (agent_1, 23) and (agent_12, 3) both mapped to "agent_123" — the second
    // task would be validated against the first task's agent prompt.
    const requestedUrls: string[] = [];
    mswServer.use(
      http.get(`${RETELL_API_BASE}/get-agent/:agentId`, ({ request, params }) => {
        const url = new URL(request.url);
        requestedUrls.push(`${url.pathname}${url.search}`);
        const version = url.searchParams.get('version');
        return HttpResponse.json({
          agent_id: params.agentId,
          ...(version !== null ? { version: Number(version) } : {}),
          response_engine: { type: 'retell-llm', llm_id: `llm_${params.agentId}` },
        });
      }),
      http.get(`${RETELL_API_BASE}/get-retell-llm/:llmId`, ({ params }) =>
        HttpResponse.json({
          llm_id: params.llmId,
          general_prompt: `Hi {{customer_name}}. (${String(params.llmId)})`,
        })),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155551234',
        tasks: [
          {
            to_number: '+14155555678',
            override_agent_id: 'agent_1',
            override_agent_version: 23,
            retell_llm_dynamic_variables: { customer_name: 'Jane' },
          },
          {
            to_number: '+14155559876',
            override_agent_id: 'agent_12',
            override_agent_version: 3,
            retell_llm_dynamic_variables: { customer_name: 'John' },
          },
        ],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    // Each distinct (agent_id, version) tuple was fetched and validated on its own.
    expect(requestedUrls).toContain('/get-agent/agent_1?version=23');
    expect(requestedUrls).toContain('/get-agent/agent_12?version=3');
  });

  it('create_batch_call validates each (agent_id, agent_version) pair against its own prompt', async () => {
    // Two tasks share override_agent_id but pin different versions. The same
    // agent ID at two versions can have different prompts, so the check must
    // fetch each version's agent and validate against that version's LLM —
    // merging them would validate against a prompt that never runs.
    const requestedUrls: string[] = [];
    mswServer.use(
      http.get(`${RETELL_API_BASE}/get-agent/:agentId`, ({ request, params }) => {
        const url = new URL(request.url);
        requestedUrls.push(`${url.pathname}${url.search}`);
        const version = url.searchParams.get('version');
        return HttpResponse.json({
          agent_id: params.agentId,
          ...(version !== null ? { version: Number(version) } : {}),
          response_engine: { type: 'retell-llm', llm_id: version === '2' ? 'llm_v2' : 'llm_v1' },
        });
      }),
      http.get(`${RETELL_API_BASE}/get-retell-llm/:llmId`, ({ params }) =>
        HttpResponse.json({
          llm_id: params.llmId,
          // v1's prompt references customer_name; v2's references order_id.
          general_prompt: params.llmId === 'llm_v2' ? 'Order {{order_id}} update.' : 'Hi {{customer_name}}.',
        })),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155551234',
        tasks: [
          {
            to_number: '+14155555678',
            override_agent_id: 'agent_multi',
            override_agent_version: 1,
            retell_llm_dynamic_variables: { customer_name: 'Jane', wrong_for_v1: 'x' },
          },
          {
            to_number: '+14155559876',
            override_agent_id: 'agent_multi',
            override_agent_version: 2,
            retell_llm_dynamic_variables: { order_id: 'A1', wrong_for_v2: 'y' },
          },
        ],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    // Both versions were fetched explicitly — never an unversioned lookup.
    expect(requestedUrls).toContain('/get-agent/agent_multi?version=1');
    expect(requestedUrls).toContain('/get-agent/agent_multi?version=2');
    expect(requestedUrls).not.toContain('/get-agent/agent_multi');
    expect(parsed.warnings).toBeInstanceOf(Array);
    // Each version's warning flags only the variables ITS prompt misses.
    const v1Warning = parsed.warnings.find((w: string) => w.includes('version 1'));
    const v2Warning = parsed.warnings.find((w: string) => w.includes('version 2'));
    expect(v1Warning).toBeDefined();
    expect(v1Warning).toContain('wrong_for_v1');
    expect(v1Warning).toContain('llm_v1');
    expect(v2Warning).toBeDefined();
    expect(v2Warning).toContain('wrong_for_v2');
    expect(v2Warning).toContain('llm_v2');
  });

  it('create_batch_call does not POST until the full phone → agent → LLM chain resolves', async () => {
    // Stronger than order-recording: the LLM leg of the prompt check is held
    // open, and the create-batch POST must be absent until it resolves.
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
      http.post(`${RETELL_API_BASE}/create-batch-call`, () => {
        createAttempts += 1;
        return HttpResponse.json({
          batch_call_id: 'batch_call_test_001',
          from_number: '+14155551234',
          scheduled_timestamp: 1704067200000,
          total_task_count: 1,
        });
      }),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const pending = testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155551234',
        tasks: [{ to_number: '+14155555678', retell_llm_dynamic_variables: { customer_name: 'Jane' } }],
      },
    });

    // Give the tool time to run the phone → agent legs and reach the held LLM
    // leg; the batch POST must not have fired yet.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(createAttempts).toBe(0);

    releaseLlm();
    const result = await pending;
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(createAttempts).toBe(1);
  });

  it('create_batch_call surfaces an explicit warning when the prompt check cannot run', async () => {
    mswServer.use(
      http.get(`${RETELL_API_BASE}/get-phone-number/:phoneNumber`, () =>
        HttpResponse.json({ error_message: 'lookup exploded' }, { status: 500 })),
      ...createRetellHandlers(),
    );
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155551234',
        tasks: [{ to_number: '+14155555678', retell_llm_dynamic_variables: { customer_name: 'Jane' } }],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    // The batch is still created (destructive tool, explicitly requested) but
    // the degraded check is OBSERVABLE — never silently absent.
    expect(parsed.ok).toBe(true);
    expect(parsed.batch_call_id).toBe('batch_call_test_001');
    expect(parsed.warnings).toBeInstanceOf(Array);
    expect(parsed.warnings.some((w: string) => w.includes('prompt check could not run'))).toBe(true);
  });

  it('create_batch_call surfaces API errors with resolution guidance', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155550000',
        tasks: [{ to_number: '+14155555678' }],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('HTTP_402');
    expect(parsed.resolution).toContain('Payment required');
  });

  it('create_batch_call warns when dynamic variables match no prompt placeholder', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_batch_call',
      arguments: {
        from_number: '+14155551234',
        tasks: [
          { to_number: '+14155555678', retell_llm_dynamic_variables: { customer_name: 'Jane' } },
        ],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    // The mock LLM prompt has no {{placeholders}}, so the pre-call check warns.
    expect(parsed.warnings).toBeInstanceOf(Array);
    expect(parsed.warnings[0]).toContain('customer_name');
  });
});
