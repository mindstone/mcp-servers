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
