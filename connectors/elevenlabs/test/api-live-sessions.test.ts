import { createRedactor } from '../src/api-sensitive.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setApiKey } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { loadApiCatalog, validateApiCatalog } from '../src/api-catalog.js';
import { createSuccessReceipt } from '../src/api-validation.js';
import { apiCatalog } from '../src/generated/api-catalog.js';
import { compileCatalog, loadCoverageRosters, PINNED_SOURCE, validatePolicy } from '../scripts/generate-api-catalog.mjs';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import cases from './fixtures/api-live-session-wire-cases.json' with { type: 'json' };
import { unwrapUntrusted } from '../src/untrusted-content.js';
import { mswServer } from './helpers/setup.js';

const root = resolve(import.meta.dirname, '..');
const rosters = await loadCoverageRosters(root);
const getCreates = ['get_conversation_signed_link', 'get_signed_url_deprecated', 'get_livekit_token'] as const;
let pair: McpTestClient;
beforeEach(async () => {
  setApiKey('example-connector-credential');
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => { await pair.close(); setApiKey(''); vi.restoreAllMocks(); });

describe('live session credential boundaries', () => {
  it('declares exactly the five reviewed effects without assumed follow-up reads', async () => {
    const catalog = await loadApiCatalog();
    expect(catalog.operations.filter(op => op.credential_return_fields).map(op => op.operation_id).sort()).toEqual(cases.map(wire => wire.id).sort());
    for (const wire of cases) {
      const op = catalog.operations.find(op => op.operation_id === wire.id)!;
      expect(op.profile).toBe(wire.profile);
      expect(op.effects).toEqual({ readOnlyHint: false, destructiveHint: wire.profile === 'place_call', idempotentHint: false, openWorldHint: true });
      expect(op.follow_ups).toEqual([]);
      expect(op.credential_return_fields).toBeDefined();
      expect(op.deprecated).toBe(wire.id === 'get_signed_url_deprecated');
    }
  });

  it.each(getCreates)('%s needs its reviewed GET-create declaration at both boundaries', id => {
    const policy = structuredClone(policyInput);
    delete (policy.operations[id] as { reviewed_get_create?: string }).reviewed_get_create;
    expect(() => validatePolicy(policy, rosters)).toThrow('method effect floor');
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    delete catalog.operations.find(op => op.operation_id === id)!.reviewed_get_create;
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it.each(cases)('$id requires its credential return declaration at generation and loading', wire => {
    const policy = structuredClone(policyInput);
    delete (policy.operations[wire.id as keyof typeof policy.operations] as { credential_return_fields?: string[][] }).credential_return_fields;
    expect(() => validatePolicy(policy, rosters)).toThrow('missing credential return fields');
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    delete catalog.operations.find(op => op.operation_id === wire.id)!.credential_return_fields;
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it.each(['sensitive_request_fields', 'sensitive_response_fields'] as const)('requires realtime authorization in %s at both boundaries', field => {
    for (const fields of [undefined, [['session', 'tools', '*', 'server_url']]]) {
      const policy = structuredClone(policyInput);
      Object.assign(policy.operations.create_realtime_session, { [field]: fields });
      expect(() => validatePolicy(policy, rosters)).toThrow('missing realtime authorization protection');
      const catalog = structuredClone(validateApiCatalog(apiCatalog));
      Object.assign(catalog.operations.find(op => op.operation_id === 'create_realtime_session')!, { [field]: fields });
      expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
    }
  });

  it('does not let a declaration move an arbitrary GET into create', () => {
    const policy = structuredClone(policyInput);
    for (const row of Object.values(policy.operations)) if ('follow_ups' in row) row.follow_ups = [];
    Object.assign(policy.operations.get_agent_route, { profile: 'create', effects: policy.operations.create_realtime_session.effects, reviewed_get_create: 'An invented review cannot widen the reviewed list.' });
    expect(() => validatePolicy(policy, rosters)).toThrow('unreviewed effect assignment');
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    for (const op of catalog.operations) op.follow_ups = [];
    Object.assign(catalog.operations.find(op => op.operation_id === 'get_agent_route')!, { profile: 'create', tool: 'elevenlabs_create_resource', effects: policy.operations.create_realtime_session.effects, reviewed_get_create: 'An invented review cannot widen the reviewed list.' });
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it.each(['get_agent_route', 'create_realtime_session', 'register_twilio_call', 'update_settings_route', 'get_workspace_batch_calls'] as const)('refuses a misplaced GET-create declaration on %s', id => {
    const policy = structuredClone(policyInput);
    Object.assign(policy.operations[id], { reviewed_get_create: 'A reason cannot authorize an unreviewed exception.' });
    expect(() => validatePolicy(policy, rosters)).toThrow();
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    const op = catalog.operations.find(op => op.operation_id === id) ?? catalog.operations[0];
    op.reviewed_get_create = 'A reason cannot authorize an unreviewed exception.';
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it.each([undefined, null, {}])('forwards the optional realtime body %j without inserting defaults', async body => {
    const received: string[] = [];
    mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/realtime/client_secrets', async ({ request }) => {
      received.push(await request.text());
      return HttpResponse.json({ value: 'example-realtime-credential', expires_at: 1800000090, session: null });
    }));
    const result = await pair.callTool('elevenlabs_create_resource', { operation_id: 'create_realtime_session', ...(body === undefined ? {} : { body }) });
    expect(result.isError, result.text).not.toBe(true);
    expect(received).toEqual([body === undefined ? '' : JSON.stringify(body)]);
    expect(result.json).toMatchObject({ response_contract: 'matched', follow_up_operations: [] });
    expect(result.json).not.toHaveProperty('next_step');
    expect(JSON.parse(unwrapUntrusted(String((result.json as { data: string }).data)))).toEqual({ value: 'example-realtime-credential', expires_at: 1800000090, session: null });
  });

  it('forwards upstream authorization unchanged but hides submitted and stored echoes while returning the new credential', async () => {
    const submitted = 'example-upstream-authorization';
    const stored = 'example-stored-authorization';
    const tool = { type: 'mcp', server_label: 'guide', server_url: 'https://example.invalid/mcp', authorization: submitted, allowed_tools: ['lookup_guide'] };
    const body = { session: { tools: [tool] }, expires_after: { seconds: 90 } };
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const received: unknown[] = [];
    mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/realtime/client_secrets', async ({ request }) => {
      received.push(await request.json());
      return HttpResponse.json({ value: 'example-realtime-credential', expires_at: 1800000090, session: { tools: [tool, { ...tool, authorization: stored }] }, echo: submitted, key_echo: 'example-connector-credential', token: 'example-undeclared-token', signed_url: 'https://example.invalid/undeclared' });
    }));
    const result = await pair.callTool('elevenlabs_create_resource', { operation_id: 'create_realtime_session', body });
    expect(result.isError, result.text).not.toBe(true);
    expect(received).toEqual([body]);
    expect(result.text).not.toContain(submitted);
    expect(result.text).not.toContain(stored);
    expect(result.text).not.toContain('example-connector-credential');
    expect(result.text).not.toContain('example-undeclared-token');
    expect(result.text).not.toContain('https://example.invalid/undeclared');
    expect(result.text).toContain('example-realtime-credential');
    expect(result.text).toContain('1800000090');
    expect(result.text).toContain('lookup_guide');
    const { data, ...diagnostics } = result.json as Record<string, unknown>;
    expect(data).toContain('example-realtime-credential');
    expect(JSON.stringify(diagnostics)).not.toContain('example-realtime-credential');
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/example-(?:upstream|stored|realtime)/);
  });

  it.each(cases.filter(wire => wire.media === 'application/json'))('$id exempts only its declared issued path and still scrubs submitted secrets', async wire => {
    const op = (await loadApiCatalog()).operations.find(op => op.operation_id === wire.id)!;
    const field = op.credential_return_fields![0][0];
    const issued = 'example-issued-credential';
    const key = 'example-connector-credential';
    const submitted = 'example-submitted-authorization';
    const response = { ...wire.response as object, [field]: issued, elsewhere: {
      key_echo: key, submitted_echo: submitted, token: issued, signed_url: issued,
      encoded: [encodeURIComponent(submitted), JSON.stringify(JSON.stringify(submitted))],
    } };
    const receipt = await createSuccessReceipt(wire.id, 200, wire.media, response, createRedactor([key, submitted]));
    const data = JSON.parse(unwrapUntrusted(receipt.data!));
    expect(data[field]).toBe(issued);
    expect(data.elsewhere).toMatchObject({ key_echo: '[REDACTED]', submitted_echo: '[REDACTED]', token: '[REDACTED]', signed_url: '[REDACTED]' });
    expect(JSON.stringify(data.elsewhere)).not.toContain(submitted);
    expect(JSON.stringify(data.elsewhere)).not.toContain(key);
    expect(receipt.data!.match(/<\/untrusted-content>/g)).toHaveLength(1);
    expect(response[field as keyof typeof response]).toBe(issued);
  });

  it.each(['example-connector-credential', 'example-submitted-authorization'])('redacts an issued token equal to the submitted secret %s', async issued => {
    const receipt = await createSuccessReceipt('get_livekit_token', 200, 'application/json', { token: issued },
      createRedactor(['example-connector-credential', 'example-submitted-authorization']));
    expect(JSON.parse(unwrapUntrusted(receipt.data!)).token).toBe('[REDACTED]');
    expect(receipt.data).not.toContain(issued);
  });

  it('keeps exact wildcard exemptions inside the same response without exempting stored credentials or encoded echoes', () => {
    const secret = 'example/submitted-credential';
    const redactor = createRedactor([secret]);
    const response = { items: [{ token: 'example-issued-token', password: 'example-stored-password' }, { token: secret }], token: 'example-other-token', echo: JSON.stringify({ token: secret }) };
    expect(redactor.redact(response, { credential_return_fields: [['items', '*', 'token']], sensitive_response_fields: [['items', '*', 'password']] })).toEqual({
      items: [{ token: 'example-issued-token', password: '[REDACTED]' }, { token: '[REDACTED]' }], token: '[REDACTED]', echo: '{"token":"[REDACTED]"}',
    });
    expect(redactor.redact('example-issued-text', { credential_return_fields: [[]] })).toBe('example-issued-text');
    expect(redactor.redact(secret, { credential_return_fields: [[]] })).toBe('[REDACTED]');
    expect(redactor.redact(encodeURIComponent(secret), { credential_return_fields: [[]] })).toBe('[REDACTED]');
  });

  it('does not exempt credential-named descendants of an issued path', () => {
    expect(createRedactor([]).redact({ token: { api_key: 'x' } }, { credential_return_fields: [['token']] }))
      .toEqual({ token: { api_key: '[REDACTED]' } });
  });

  it('scrubs nested authorization from local validation diagnostics', async () => {
    const secret = 'example-upstream-authorization';
    const result = await pair.callTool('elevenlabs_create_resource', { operation_id: 'create_realtime_session', body: { session: { tools: [{ type: 'mcp', server_label: 'guide', server_url: 'https://example.invalid/mcp', authorization: secret }], [secret]: true } } });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain('[REDACTED]');
  });

  it.each(cases)('$id contains credential-shaped schema mismatches only in intended data', async wire => {
    const credential = 'example-returned-credential';
    const response = wire.media === 'text/html' ? `<Response>${credential}</Response>` : { ...wire.response as object, [credential]: true, expires_at: { [credential]: true } };
    const receipt = await createSuccessReceipt(wire.id, 200, wire.media, response, createRedactor([]));
    const { data, ...diagnostics } = receipt;
    expect(data).toContain(credential);
    expect(JSON.stringify(diagnostics)).not.toContain(credential);
    expect(diagnostics).not.toHaveProperty('next_step');
  });

  it.each(cases.flatMap(wire => [400, 401, 403, 422, 500].map(status => ({ wire, status }))))('$wire.id HTTP $status uses static diagnostics and dispatches once', async ({ wire, status }) => {
    const credential = 'example-provider-error-credential';
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispatch = vi.fn(() => HttpResponse.json({ detail: { status: 'missing_permissions', message: credential, [credential]: credential } }, { status, statusText: credential }));
    mswServer.use(http.all('https://api.elevenlabs.io/*', dispatch));
    const result = await pair.callTool(wire.profile === 'place_call' ? 'elevenlabs_place_call' : 'elevenlabs_create_resource', { operation_id: wire.id, ...wire.args });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(credential);
    expect(result.text).not.toContain('detail');
    expect(unwrapUntrusted(String((result.json as { error: string }).error))).toBe(`The provider rejected the request (${status === 401 ? 'MISSING_PERMISSION' : status === 403 ? 'AUTH_FAILED' : `HTTP_${status}`}).`);
    expect(result.json).toHaveProperty('code', status === 401 ? 'MISSING_PERMISSION' : status === 403 ? 'AUTH_FAILED' : `HTTP_${status}`);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(credential);
    expect(result.text).toContain(wire.profile === 'create' ? 'No credential was confirmed.' : 'get_conversation_histories_route');
    if (wire.profile === 'create') expect(result.text).not.toContain('get_conversation_histories_route');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(cases)('$id timeout resolves without an irrelevant credential verification read', async wire => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    mswServer.use(http.all('https://api.elevenlabs.io/*', () => {
      controller.abort(new DOMException('timed out', 'TimeoutError'));
      return HttpResponse.error();
    }));
    const result = await pair.callTool(wire.profile === 'place_call' ? 'elevenlabs_place_call' : 'elevenlabs_create_resource', { operation_id: wire.id, ...wire.args });
    expect(result.json).toMatchObject({ code: 'TIMEOUT' });
    expect(result.text).toContain(wire.profile === 'create' ? 'No credential was confirmed.' : 'get_conversation_histories_route');
    if (wire.profile === 'create') expect(result.text).not.toContain('get_conversation_histories_route');
  });

  it.each(['inbound', 'outbound'])('returns %s registration as inert enveloped TwiML without following URLs', async direction => {
    const wire = cases.find(wire => wire.id === 'register_twilio_call')!;
    const dispatch = vi.fn(() => new HttpResponse(String(wire.response), { headers: { 'Content-Type': 'text/html' } }));
    mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/twilio/register-call', dispatch));
    const result = await pair.callTool('elevenlabs_place_call', { operation_id: wire.id, body: { ...wire.body, direction } });
    expect(result.isError, result.text).not.toBe(true);
    expect(unwrapUntrusted(String((result.json as { data: string }).data))).toBe(wire.response);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.json).not.toHaveProperty('next_step');
  });
});

const source = process.env.ELEVENLABS_OPENAPI_SPEC;
it.skipIf(!source)('refuses duplicate, unbound, invalid and overlapping credential declarations at generation and loading', async () => {
  const bytes = await readFile(source!);
  for (const fields of [[['value'], ['value']], [['missing']], [[]], [['']], ['value']]) {
    const policy = structuredClone(policyInput);
    Object.assign(policy.operations.create_realtime_session, { credential_return_fields: fields });
    expect(() => compileCatalog(bytes, policy, PINNED_SOURCE, rosters)).toThrow();
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    Object.assign(catalog.operations.find(op => op.operation_id === 'create_realtime_session')!, { credential_return_fields: fields });
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  }
  const policy = structuredClone(policyInput);
  Object.assign(policy.operations.create_realtime_session, { credential_return_fields: [['session', 'tools', '*', 'authorization']] });
  expect(() => compileCatalog(bytes, policy, PINNED_SOURCE, rosters)).toThrow('overlapping');
  const catalog = structuredClone(validateApiCatalog(apiCatalog));
  catalog.operations.find(op => op.operation_id === 'create_realtime_session')!.credential_return_fields = [['session', 'tools', '*', 'authorization']];
  expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  for (const id of ['dubbing_language_get', 'redirect_to_mintlify'] as const) {
    const unadmitted = structuredClone(policyInput);
    Object.assign(unadmitted.operations[id], { credential_return_fields: [['value']] });
    expect(() => validatePolicy(unadmitted, rosters)).toThrow('non-admitted transport metadata');
  }
});
