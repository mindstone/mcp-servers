import { createRedactor } from '../src/api-sensitive.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { setApiKey } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { getOperation, validateApiCatalog } from '../src/api-catalog.js';
import { createSuccessReceipt } from '../src/api-validation.js';
import { apiCatalog } from '../src/generated/api-catalog.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import cases from './fixtures/api-phone-management-wire-cases.json' with { type: 'json' };
import { apiWireCases } from './fixtures/api-wire-cases.js';
import { mswServer } from './helpers/setup.js';

const sip = {
  provider: 'sip_trunk', phone_number: '+12025550100', label: 'Acme desk', agent_id: null,
  inbound_trunk_config: { credentials: { username: 'guide', password: 'example-inbound-password' }, allowed_addresses: ['192.0.2.1'], allowed_numbers: ['+12025550101'], remote_domains: ['sip.example.invalid'], attributes_to_headers: { label: 'X-Label' } },
  outbound_trunk_config: { address: 'sip.example.invalid', credentials: { username: 'guide', password: 'example-outbound-password' }, headers: { 'X-Guide': 'example-header-credential' }, enabled_codecs: ['PCMU/8000', 'G722/8000'] },
};
const imports = [
  cases.find(wire => wire.id === 'create_phone_number_route')!.body!,
  { provider: 'exotel', phone_number: '+12025550100', label: 'Acme desk', account_sid: 'example-exotel-sid', api_key: 'example-exotel-key', api_token: 'example-exotel-token', api_subdomain: 'api.in.exotel.com', app_id: 'app_example', applet_url: null },
  sip,
];
const patch = structuredClone(cases.find(wire => wire.id === 'update_phone_number_route')!);
patch.body.outbound_trunk_config.headers['X-Guide'] = 'example-patch-header-credential';
patch.args.body.outbound_trunk_config.headers['X-Guide'] = 'example-patch-header-credential';
const writes = [...imports.map((body, index) => ({ secrets: [['example-twilio-token', 'example-account-token', 'example-region-token'], ['example-exotel-key', 'example-exotel-token'], ['example-inbound-password', 'example-outbound-password', 'example-header-credential']][index], id: 'create_phone_number_route', args: { body }, body, response: { phone_number_id: 'phone_example' } })), { secrets: ['example-sip-password', 'example-inbound-password', 'example-patch-header-credential'], id: patch.id, args: patch.args, body: patch.body!, response: patch.response }];
let pair: McpTestClient;
beforeEach(async () => { setApiKey('example-connector-credential'); pair = await createInMemoryTestClient({ createServer }); });
afterEach(async () => { await pair.close(); setApiKey(''); vi.restoreAllMocks(); });

describe('phone and account configuration', () => {
  it.each([
    'get_phone_number_route', 'list_phone_numbers_route', 'list_phone_numbers_page_route', 'update_phone_number_route',
    'get_agent_route', 'patch_agent_settings_route', 'merge_preview_route', 'rebase_preview_route',
  ])('%s hides stored SIP header values while preserving trunk metadata', async id => {
    const wire = apiWireCases.find(wire => wire.id === id)!;
    const trunk = {
      address: 'sip.example.invalid', transport: 'tls', media_encryption: 'required',
      headers: { 'X-Guide': 'example-stored-header-credential' },
      has_auth_credentials: true, username: 'guide', attributes_to_headers: { label: 'X-Label' },
      has_outbound_trunk: true, enabled_codecs: ['PCMU/8000'],
    };
    const number = {
      phone_number: '+12025550100', label: 'Acme desk', phone_number_id: 'phone_example',
      provider: 'sip_trunk', livekit_stack: 'standard', outbound_trunk: trunk, provider_config: trunk,
    };
    const single = ['get_phone_number_route', 'update_phone_number_route'].includes(id);
    const response = single ? number : id === 'list_phone_numbers_route' ? [number]
      : { ...wire.response as object, phone_numbers: [number] };
    const dispatch = vi.fn(() => HttpResponse.json(response));
    mswServer.use(http.all('https://api.elevenlabs.io/*', dispatch));
    const result = await pair.callTool(`elevenlabs_${wire.profile}_resource`, { operation_id: id, ...wire.args });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.json).toMatchObject({ response_contract: 'matched' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const data = JSON.parse(unwrapUntrusted(String((result.json as { data: string }).data)));
    const returned = single ? data : id === 'list_phone_numbers_route' ? data[0] : data.phone_numbers[0];
    const hidden = { ...trunk, headers: { 'X-Guide': '[REDACTED]' } };
    expect(returned).toEqual({ ...number, outbound_trunk: hidden, provider_config: hidden });
    expect(result.text).not.toContain('example-stored-header-credential');
    expect(number.outbound_trunk.headers['X-Guide']).toBe('example-stored-header-credential');
  });

  it.each(writes)('$id forwards provider inputs and redacts submitted credential echoes', async wire => {
    const secrets = wire.secrets;
    expect(secrets.length).toBeGreaterThan(0);
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    let received: unknown;
    const dispatch = vi.fn(async ({ request }: { request: Request }) => {
      received = await request.json();
      return HttpResponse.json({ ...wire.response, echoed: secrets, [secrets[0]]: secrets[0] });
    });
    mswServer.use(http.all('https://api.elevenlabs.io/*', dispatch));
    const result = await pair.callTool('elevenlabs_change_resource', { operation_id: wire.id, ...wire.args });
    expect(result.isError, result.text).not.toBe(true);
    expect(received).toEqual(wire.body);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('[REDACTED]');
    for (const secret of secrets) {
      expect(result.text).not.toContain(secret);
      expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
    }
  });

  it.each(writes.flatMap(wire => [400, 422, 500].map(status => ({ wire, status }))))('$wire.id HTTP $status contains credential echoes', async ({ wire, status }) => {
    const secrets = wire.secrets;
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispatch = vi.fn(() => HttpResponse.json({ detail: { message: secrets.join(' '), [secrets[0]]: secrets } }, { status }));
    mswServer.use(http.all('https://api.elevenlabs.io/*', dispatch));
    const result = await pair.callTool('elevenlabs_change_resource', { operation_id: wire.id, ...wire.args });
    expect(result.isError).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    for (const secret of secrets) {
      expect(result.text).not.toContain(secret);
      expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
    }
  });

  it.each(writes)('$id contains credential-bearing local validation input before dispatch', async wire => {
    const secrets = wire.secrets;
    const dispatch = vi.fn(() => HttpResponse.json({}));
    mswServer.use(http.all('https://api.elevenlabs.io/*', dispatch));
    const result = await pair.callTool('elevenlabs_change_resource', { operation_id: wire.id, ...wire.args, body: { ...wire.body, label: { [secrets[0]]: true } } });
    expect(result.json).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(result.text).not.toContain(secrets[0]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([undefined, null].flatMap(password => ['create_phone_number_route', 'update_phone_number_route'].map(id => ({ password, id }))))('$id preserves an omitted or null SIP password ($password)', async ({ password, id }) => {
    const configs = { inbound_trunk_config: { credentials: { username: 'guide', ...(password === undefined ? {} : { password }) } }, outbound_trunk_config: { address: 'sip.example.invalid', credentials: { username: 'guide', ...(password === undefined ? {} : { password }) } } };
    const body = id === 'create_phone_number_route' ? { ...sip, ...configs } : configs;
    let received: unknown;
    mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => { received = await request.json(); return HttpResponse.json(id === 'create_phone_number_route' ? { phone_number_id: 'phone_example' } : patch.response); }));
    expect((await pair.callTool('elevenlabs_change_resource', { operation_id: id, ...(id === 'update_phone_number_route' ? { path_params: { phone_number_id: 'phone_example' } } : {}), body })).isError).not.toBe(true);
    expect(received).toEqual(body);
  });

  it('does not invent a WhatsApp token input', async () => {
    const catalog = validateApiCatalog(apiCatalog);
    expect(catalog.$defs.UpdateWhatsAppAccountRequest).not.toHaveProperty('properties.token');
    expect(catalog.$defs.UpdateWhatsAppAccountRequest).toHaveProperty('properties.assigned_agent_id');
    const op = await getOperation('update_whatsapp_account');
    expect(op.sensitive_request_fields).toBeUndefined();
  });

  it.each(['list_phone_numbers_page_route', 'list_sip_messages'])('%s consumes a cursor and refuses malformed pagination', async id => {
    const wire = cases.find(wire => wire.id === id)!;
    const seen: string[] = [];
    mswServer.use(http.get('https://api.elevenlabs.io/*', ({ request }) => {
      seen.push(new URL(request.url).searchParams.get('cursor')!);
      return HttpResponse.json(wire.response);
    }));
    const first = await pair.callTool('elevenlabs_read_resource', { operation_id: id, ...wire.args });
    expect(first.json).toMatchObject({ has_more: true, next: expect.any(String), response_contract: 'matched' });
    const data = JSON.parse(unwrapUntrusted(String((first.json as { data: string }).data)));
    expect((await pair.callTool('elevenlabs_read_resource', { operation_id: id, ...wire.args, query_params: { ...wire.args.query_params, cursor: data.next_cursor } })).isError).not.toBe(true);
    expect(seen).toEqual(['page & 2', data.next_cursor]);
    for (const response of [{ ...wire.response, has_more: true, next_cursor: null }, { ...wire.response, has_more: 'true' }, { ...wire.response, next_cursor: 2 }]) {
      await expect(createSuccessReceipt(id, 200, 'application/json', response, createRedactor([]))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    catalog.operations.find(op => op.operation_id === id)!.pagination!.response = 'missing_cursor';
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
    if (id === 'list_sip_messages') {
      expect(String((first.json as { data: string }).data).match(/<\/untrusted-content>/g)).toHaveLength(1);
      expect(data.sip_messages[0].raw_message).toBe('[REDACTED]');
    }
  });

  it.each(['list_sip_messages', 'get_conversation_sip_messages'])('%s withholds stored custom and authorization headers in raw logs', async id => {
    const wire = cases.find(wire => wire.id === 'list_sip_messages')!;
    const response = structuredClone(wire.response);
    response.sip_messages[0].raw_message = 'INVITE sip:guide@example.invalid SIP/2.0\r\nX-Guide: stored-sip-header-canary\r\nAuthorization: Bearer stored-sip-auth-canary\r\n\r\n';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(response));
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id: id, path_params: id === 'list_sip_messages' ? { phone_number_id: 'phone_example' } : { conversation_id: 'conversation_example' } });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.json).toMatchObject({ response_contract: 'matched' });
    const data = JSON.parse(unwrapUntrusted(String((result.json as { data: string }).data)));
    expect(data.sip_messages[0]).toMatchObject({ raw_message: '[REDACTED]', call_id: 'call_example', transport: 'tls' });
    expect(result.text).not.toContain('stored-sip-header-canary'); expect(result.text).not.toContain('stored-sip-auth-canary');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
