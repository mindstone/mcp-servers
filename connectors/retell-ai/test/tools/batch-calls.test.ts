import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from '../helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from '../helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

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
