import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from '../helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

const RETELL_API_BASE = 'https://api.retellai.com';

describe('create_phone_call — E.164 validation (M3.10)', () => {
  let testClient: McpTestClient;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  // --- Positive cases ---

  it('VAL-RETELL-001 — valid E.164 NANP number accepted, upstream invoked once', async () => {
    let upstreamCount = 0;
    mswServer.use(
      http.post(`${RETELL_API_BASE}/v2/create-phone-call`, async ({ request }) => {
        const auth = request.headers.get('authorization');
        if (auth !== `Bearer ${MOCK_API_KEY}`) {
          return HttpResponse.json({ error_message: 'unauth' }, { status: 401 });
        }
        upstreamCount++;
        return HttpResponse.json({ call_id: 'c1', status: 'queued' });
      }),
    );

    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_phone_call',
      arguments: { from_number: '+14155551234', to_number: '+14155551234' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.call_id).toBe('c1');
    expect(upstreamCount).toBe(1);
  });

  it('VAL-RETELL-002 — international E.164 (UK, 13 digits) accepted', async () => {
    let upstreamCount = 0;
    mswServer.use(
      http.post(`${RETELL_API_BASE}/v2/create-phone-call`, () => {
        upstreamCount++;
        return HttpResponse.json({ call_id: 'c2', status: 'queued' });
      }),
    );

    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_phone_call',
      arguments: { from_number: '+442071838750', to_number: '+442071838750' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.ok).toBe(true);
    expect(parsed.call_id).toBe('c2');
    expect(upstreamCount).toBe(1);
  });

  // --- Negative cases ---

  async function expectRejected(
    args: { from_number: string; to_number: string },
  ): Promise<void> {
    let upstreamCount = 0;
    mswServer.use(
      http.post(`${RETELL_API_BASE}/v2/create-phone-call`, () => {
        upstreamCount++;
        return HttpResponse.json({ call_id: 'should_not_happen' });
      }),
    );

    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'create_phone_call',
      arguments: args,
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;

    expect(result.isError).toBe(true);
    expect(text).toMatch(/E\.?164|format/i);
    expect(upstreamCount).toBe(0);
  }

  it('VAL-RETELL-101 — no leading + rejected', async () => {
    await expectRejected({ from_number: '14155551234', to_number: '+14155551234' });
  });

  it('VAL-RETELL-102 — spaces inside number rejected', async () => {
    await expectRejected({ from_number: '+ 1 415 555 1234', to_number: '+14155551234' });
  });

  it('VAL-RETELL-103 — parens / dashes rejected', async () => {
    await expectRejected({ from_number: '+(415)555-1234', to_number: '+14155551234' });
  });

  it('VAL-RETELL-104 — leading zero in country code rejected', async () => {
    await expectRejected({ from_number: '+04155551234', to_number: '+14155551234' });
  });

  it('VAL-RETELL-105 — too short (only +1) rejected', async () => {
    await expectRejected({ from_number: '+1', to_number: '+14155551234' });
  });

  it('VAL-RETELL-106 — too long (16 digits) rejected', async () => {
    await expectRejected({ from_number: '+1234567890123456', to_number: '+14155551234' });
  });

  it('VAL-RETELL-107 — invalid to_number rejected (mirror of from_number)', async () => {
    await expectRejected({ from_number: '+14155551234', to_number: '14155551234' });
  });

  // --- Annotation behavioural check ---

  it('VAL-RETELL-201 — create_phone_call has destructiveHint:true via tools/list', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.listTools();
    const tool = result.tools.find((t) => t.name === 'create_phone_call');
    expect(tool, 'create_phone_call must be registered').toBeDefined();
    expect(tool!.annotations?.destructiveHint).toBe(true);
  });
});
