import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { setApiKey } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { discoverOperations, loadApiCatalog } from '../src/api-catalog.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import cases from './fixtures/api-calling-wire-cases.json' with { type: 'json' };
import batchCases from './fixtures/api-batch-calling-wire-cases.json' with { type: 'json' };
import { mswServer } from './helpers/setup.js';

let pair: McpTestClient;
beforeEach(async () => { setApiKey('example-connector-credential'); pair = await createInMemoryTestClient({ createServer }); });
afterEach(async () => { await pair.close(); setApiKey(''); vi.restoreAllMocks(); });

describe('outbound recipient contacts', () => {
  it('keeps exactly eight contact and registration operations exclusively in the destructive call profile', async () => {
    const catalog = await loadApiCatalog();
    expect(catalog.operations.filter(op => op.profile === 'place_call').map(op => op.operation_id).sort()).toEqual([
      'create_batch_call', 'handle_exotel_outbound_call', 'handle_sip_trunk_outbound_call', 'handle_twilio_outbound_call',
      'register_twilio_call', 'retry_batch_call', 'whatsapp_outbound_call', 'whatsapp_outbound_message',
    ]);
    // The SDK's independent wire matrix tries every other profile before auth, file reads or HTTP.
    for (const wire of cases) {
      const op = catalog.operations.find(op => op.operation_id === wire.id)!;
      expect(op).toMatchObject({ profile: 'place_call', effects: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } });
      expect(await discoverOperations({ operation_id: wire.id })).toHaveProperty('instructions', expect.stringContaining('does not prove that a person answered or received a message'));
    }
  });

  it.each([undefined, null, true, false])('forwards optional Twilio recording control %s and null client data unchanged', async recording => {
    const body = { agent_id: 'agent_guide', agent_phone_number_id: 'phone_guide', to_number: '+12025550101', conversation_initiation_client_data: null,
      ...(recording === undefined ? {} : { call_recording_enabled: recording }) };
    let received: unknown;
    mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', async ({ request }) => {
      received = await request.json(); return HttpResponse.json(cases[0].response);
    }));
    const result = await pair.callTool('elevenlabs_place_call', { operation_id: 'handle_twilio_outbound_call', body });
    expect(result.isError, result.text).not.toBe(true);
    expect(received).toEqual(body);
    expect(received).not.toHaveProperty('telephony_call_config');
  });

  it.each(cases.filter(wire => wire.id !== 'whatsapp_outbound_message'))('$id preserves provider rejection and null identifiers without claiming a completed call', async wire => {
    const response = { ...wire.response, success: false, message: 'Provider did not accept the call.', conversation_id: null };
    if ('callSid' in response) response.callSid = null;
    if ('sip_call_id' in response) response.sip_call_id = null;
    const dispatch = vi.fn(() => HttpResponse.json(response));
    mswServer.use(http.post('https://api.elevenlabs.io/*', dispatch));
    const result = await pair.callTool('elevenlabs_place_call', { operation_id: wire.id, ...wire.args });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.json).toMatchObject({ response_contract: 'matched', message: 'The provider returned a success response.' });
    expect(JSON.parse(unwrapUntrusted(String((result.json as { data: string }).data)))).toEqual(response);
    expect(result.text).not.toMatch(/call (?:completed|connected)|message delivered/i);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([...cases, ...batchCases.filter(wire => ['create_batch_call', 'retry_batch_call'].includes(wire.id))].flatMap(wire =>
    ['timeout', 'server', 'malformed', 'media'].map(failure => ({ wire, failure }))))('$wire.id dispatches once on $failure and advises inspection before another contact', async ({ wire, failure }) => {
    const dispatch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (failure === 'timeout') throw new DOMException('Synthetic timeout', 'TimeoutError');
      if (failure === 'server') return HttpResponse.json({ detail: 'Synthetic unavailable' }, { status: 503 });
      return new HttpResponse('{broken', { headers: { 'Content-Type': failure === 'media' ? 'text/plain' : 'application/json' } });
    });
    const result = await pair.callTool('elevenlabs_place_call', { operation_id: wire.id, ...wire.args });
    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ code: failure === 'timeout' ? 'TIMEOUT' : failure === 'server' ? 'HTTP_503' : 'INVALID_RESPONSE' });
    expect(result.text).toContain('before retrying');
    expect(result.text).toContain('elevenlabs_read_resource');
    expect((result.json as { resolution: string }).resolution).not.toContain('retry_batch_call');
    expect(result.text).not.toContain('call completed');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
