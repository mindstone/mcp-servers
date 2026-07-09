import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsAgentsHandlers,
  createSubmitBatchCallCapturingHandler,
  MOCK_API_KEY,
} from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { BATCH_SCHEDULED_TIME_UNIX } from './fixtures/elevenlabs-agents-data.js';

describe('batch call tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('submits a batch call and maps recipient dynamic variables into conversation initiation data', async () => {
    const { handler, captured } = createSubmitBatchCallCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('submit_batch_call', {
      call_name: 'Renewals wave 1',
      agent_id: 'agent_test_123',
      agent_phone_number_id: 'pn_test_123',
      recipients: [
        {
          phone_number: '+14155559876',
          dynamic_variables: { customer_name: 'Jane' },
        },
        {
          phone_number: '+14155557654',
        },
      ],
      scheduled_time_unix: BATCH_SCHEDULED_TIME_UNIX,
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      call_name: 'Renewals wave 1',
      agent_id: 'agent_test_123',
      agent_phone_number_id: 'pn_test_123',
      recipients: [
        {
          phone_number: '+14155559876',
          conversation_initiation_client_data: {
            dynamic_variables: { customer_name: 'Jane' },
          },
        },
        {
          phone_number: '+14155557654',
        },
      ],
      scheduled_time_unix: BATCH_SCHEDULED_TIME_UNIX,
    });
    expect(result.json.batch_id).toBe('batch_test_123');
    expect(result.json.batch_call.batch_id).toBe('batch_test_123');
    expect(result.json.batch_call.id).toBeUndefined();
  });

  it('accepts ISO scheduled_time_unix values and converts them to epoch seconds', async () => {
    const { handler, captured } = createSubmitBatchCallCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('submit_batch_call', {
      call_name: 'Renewals wave 1',
      agent_id: 'agent_test_123',
      recipients: [{ phone_number: '+14155559876' }],
      scheduled_time_unix: '2030-01-01T00:00:00Z',
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body?.scheduled_time_unix).toBe(1_893_456_000);
  });

  it('chains list_batch_calls batch_id into get_batch_call and cancel_batch_call', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const listed = await testClient.callTool('list_batch_calls', { limit: 1 });
    expect(listed.isError).toBeFalsy();
    expect(listed.json.batch_calls[0].batch_id).toBe('batch_test_123');
    expect(listed.json.batch_calls[0].id).toBeUndefined();

    const batchId = listed.json.batch_calls[0].batch_id;
    const got = await testClient.callTool('get_batch_call', { batch_id: batchId });
    expect(got.isError).toBeFalsy();
    expect(got.json.batch_id).toBe(batchId);
    expect(got.json.batch_call.batch_id).toBe(batchId);

    const cancelled = await testClient.callTool('cancel_batch_call', { batch_id: batchId });
    expect(cancelled.isError).toBeFalsy();
    expect(cancelled.json.batch_id).toBe(batchId);
    expect(cancelled.json.batch_call.status).toBe('cancelled');
  });

  it('lists, gets, cancels, and retries batch calls', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const listed = await testClient.callTool('list_batch_calls', { limit: 1 });
    expect(listed.isError).toBeFalsy();
    expect(listed.json.count).toBe(1);
    expect(listed.json.next_cursor).toBe('batch_cursor_2');

    const got = await testClient.callTool('get_batch_call', { batch_id: 'batch_test_123' });
    expect(got.isError).toBeFalsy();
    expect(got.json.batch_call.recipients[1].status).toBe('failed');

    const cancelled = await testClient.callTool('cancel_batch_call', { batch_id: 'batch_test_123' });
    expect(cancelled.isError).toBeFalsy();
    expect(cancelled.json.batch_call.status).toBe('cancelled');

    const retried = await testClient.callTool('retry_batch_call', { batch_id: 'batch_test_123' });
    expect(retried.isError).toBeFalsy();
    expect(retried.json.batch_call.status).toBe('queued');
  });

  it('rejects millisecond-looking scheduled_time_unix values', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('submit_batch_call', {
      call_name: 'Renewals wave 1',
      agent_id: 'agent_test_123',
      recipients: [{ phone_number: '+14155559876' }],
      scheduled_time_unix: 1_735_689_600_000,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('looks like milliseconds');
  });

  it('rejects scheduled times in the past', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('submit_batch_call', {
      call_name: 'Renewals wave 1',
      agent_id: 'agent_test_123',
      recipients: [{ phone_number: '+14155559876' }],
      scheduled_time_unix: Math.floor(Date.now() / 1000) - 60,
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      ok: false,
      code: 'INVALID_SCHEDULED_TIME',
    });
  });

  it('rejects per-recipient non-E.164 phone numbers with the failing index', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('submit_batch_call', {
      call_name: 'Renewals wave 1',
      agent_id: 'agent_test_123',
      recipients: [
        { phone_number: '+14155559876' },
        { phone_number: '415-555-7654' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      ok: false,
      code: 'INVALID_PHONE_NUMBER',
    });
    expect(result.text).toContain('recipients[1].phone_number');
  });

  it('rejects empty recipients before any network request', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('submit_batch_call', {
      call_name: 'Renewals wave 1',
      agent_id: 'agent_test_123',
      recipients: [],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('at least 1');
  });
});
