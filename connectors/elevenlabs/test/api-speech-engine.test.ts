import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import { setApiKey } from '../src/auth.js';
import { getOperation } from '../src/api-catalog.js';
import { credentialIdentifiers } from '../src/api-credential-keys.mjs';
import { sensitiveValues } from '../src/api-sensitive.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import { mswServer } from './helpers/setup.js';
import cases from './fixtures/api-speech-engine-wire-cases.json' with { type: 'json' };

let pair: McpTestClient;
const args = (row: typeof cases[number]) => ({ operation_id: row.id, ...row.args });
const tool = (profile: string) => `elevenlabs_${profile}_resource`;
const receipt = (text: string) => JSON.parse(text);
const data = (text: string) => JSON.parse(unwrapUntrusted(receipt(text).data));
const full = cases.filter(row => row.response?.speech_engine);
const writes = cases.filter(row => ['create', 'change'].includes(row.profile));
beforeEach(async () => {
  setApiKey('synthetic-speech-engine-key');
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => { await pair.close(); vi.restoreAllMocks(); setApiKey(''); });

it.each(cases)('$id preserves its literal wire contract, statuses, effects and stored header alternatives', async row => {
  const requests: Request[] = [];
  mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => {
    requests.push(request);
    expect(request.method).toBe(row.method);
    expect(new URL(request.url).pathname).toBe(row.path);
    expect([...new URL(request.url).searchParams]).toEqual(row.query);
    expect(await request.text()).toBe(row.args.body === undefined ? '' : JSON.stringify(row.args.body));
    expect(request.headers.get('xi-api-key')).toBe('synthetic-speech-engine-key');
    expect(request.redirect).toBe('manual');
    return row.status === 204 ? new HttpResponse(null, { status: 204 }) : HttpResponse.json(row.response, { status: row.status });
  }));
  const result = await pair.callTool(tool(row.profile), args(row));
  expect(result.isError, result.text).not.toBe(true); expect(requests).toHaveLength(1);
  const output = receipt(result.text);
  expect(output).toMatchObject({ status: row.status, response_contract: 'matched', effects: {
    readOnlyHint: row.profile === 'read', destructiveHint: ['delete', 'change'].includes(row.profile), idempotentHint: row.profile === 'read', openWorldHint: true,
  }, follow_up_operations: row.follow_ups });
  const op = await getOperation(row.id);
  expect(op.timeout).toBe('standard'); expect(op.request.files).toBeUndefined();
  if (row.status === 204) { expect(output.data).toBeNull(); expect(output.content_type).toBeNull(); }
  else if (row.response?.speech_engine) {
    const expected = structuredClone(row.response);
    expected.speech_engine!.request_headers['X-Upstream'] = '[REDACTED]';
    if (row.args.body && 'speech_engine' in row.args.body) expected.speech_engine!.ws_url = '[REDACTED]';
    expect(data(result.text)).toEqual(expected);
    expect(result.text).not.toContain('stored-literal-header-credential');
    expect(data(result.text).speech_engine.request_headers).toEqual({
      'X-Upstream': '[REDACTED]', 'X-Reference': { secret_id: 'secret_reference' }, 'X-Dynamic': { variable_name: 'customer_region' },
    });
    expect(data(result.text).auth).toEqual({ enable_auth: true });
    expect(data(result.text).privacy).toEqual(row.response.privacy);
    if (row.id === 'get_speech_engine') {
      expect(data(result.text).speech_engine.ws_url).toBe(row.response.speech_engine.ws_url);
      expect(receipt(result.text).data).toMatch(/^<untrusted-content /);
    }
  } else expect(data(result.text)).toEqual(row.response);
});

it.each(full)('$id declares exact stored-header paths and preserves structured alternatives in discovery', async row => {
  const op = await getOperation(row.id);
  expect(op.sensitive_response_fields).toEqual([['speech_engine', 'request_headers', '*']]);
  const discovered = await pair.callTool('elevenlabs_discover_api', { operation_id: row.id });
  expect(discovered.isError, discovered.text).not.toBe(true);
  for (const text of ['auth.enable_auth defaults to false', 'an ID alone may then start conversations', 'bursting', 'speculative generation', 'retranscription', 'billed per file']) expect(discovered.text).toContain(text);
  for (const [definition, field] of [['ConvAISecretLocator', 'secret_id'], ['ConvAIDynamicVariable', 'variable_name']]) {
    const details = await pair.callTool('elevenlabs_discover_api', { operation_id: row.id, definition });
    expect(details.isError, details.text).not.toBe(true);
    const contract = JSON.parse(unwrapUntrusted(JSON.parse(details.text).contract));
    expect(contract.definition.name).toBe(definition);
    expect(contract.definition.schema.properties).toHaveProperty(field);
  }
  if (['create_speech_engine', 'update_speech_engine'].includes(row.id)) {
    expect(discovered.text).toContain('reply hides the submitted ws_url');
    expect(discovered.text).toContain('get_speech_engine shows the stored URL');
  }
});

it.each(writes.filter(row => row.id !== 'duplicate_speech_engine'))('$id protects submitted headers and ws_url against raw and encoded diagnostic echoes', async row => {
  const secret = 'wss://reader:synthetic-password@transcripts.example.com/socket?credential=synthetic';
  const header = 'submitted-header-value/+?';
  const literalVariableHeader = 'literal-variable-header/+?';
  const config = { ws_url: secret, request_headers: { variable_name: literalVariableHeader, 'X-Upstream': header, 'X-Reference': { secret_id: 'secret_reference' }, 'X-Dynamic': { variable_name: 'customer_region' } } };
  const op = await getOperation(row.id);
  expect(op.sensitive_request_fields).toContainEqual(['speech_engine', 'ws_url']);
  expect(op.sensitive_request_fields).toContainEqual(['speech_engine', 'request_headers', '*']);
  const secrets = sensitiveValues({ speech_engine: config }, op.sensitive_request_fields!);
  expect(secrets).toContain(secret); expect(secrets).toContain(header); expect(secrets).toContain(literalVariableHeader);
  expect(secrets).not.toContain('secret_reference'); expect(secrets).not.toContain('customer_region');
  const fetch = vi.spyOn(globalThis, 'fetch');
  const spellings = [secret, header, literalVariableHeader].flatMap(value => [value, encodeURIComponent(value), encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, escape => escape.toLowerCase()), JSON.stringify(value).replace(/\//g, '\\/')]);
  const echo = spellings.join(' ');
  for (const failed of [false, true]) {
    fetch.mockResolvedValueOnce(Response.json(failed ? { detail: { message: echo } } : { ...row.response, speech_engine: config, diagnostic: echo }, { status: failed ? 400 : row.status }));
    const result = await pair.callTool(tool(row.profile), { ...args(row), body: { ...row.args.body, speech_engine: config } });
    expect(Boolean(result.isError)).toBe(failed);
    if (!failed) {
      expect(data(result.text).speech_engine).toEqual({ ws_url: '[REDACTED]', request_headers: {
        variable_name: '[REDACTED]', 'X-Upstream': '[REDACTED]', 'X-Reference': { secret_id: 'secret_reference' }, 'X-Dynamic': { variable_name: 'customer_region' },
      } });
      expect(receipt(result.text).diagnostic).toBeUndefined();
      expect(result.text).toContain('[REDACTED]');
    }
    for (const value of spellings) expect(result.text).not.toContain(value);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url] of fetch.mock.calls) expect(String(url)).toBe(`https://api.elevenlabs.io${row.path}`);
});

it('reads the returned new copy ID on success and never presents the source as lost-copy verification', async () => {
  const row = cases.find(item => item.id === 'duplicate_speech_engine')!;
  const calls: string[] = [];
  mswServer.use(http.all('https://api.elevenlabs.io/*', ({ request }) => {
    calls.push(new URL(request.url).pathname);
    if (request.method === 'POST') return HttpResponse.json(row.response, { status: 201 });
    expect(new URL(request.url).pathname).toBe('/v1/speech-engine/seng_new');
    return HttpResponse.json(row.response);
  }));
  const created = await pair.callTool(tool(row.profile), args(row));
  expect(created.isError, created.text).not.toBe(true);
  expect(data(created.text).speech_engine_id).toBe('seng_new');
  expect(data(created.text).speech_engine_id).not.toBe(row.args.path_params!.speech_engine_id);
  expect(receipt(created.text).next_step).toContain('get_speech_engine');
  const discovered = await pair.callTool('elevenlabs_discover_api', { operation_id: row.id });
  expect(discovered.text).toContain('returned NEW speech_engine_id');
  const read = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_speech_engine', path_params: { speech_engine_id: data(created.text).speech_engine_id } });
  expect(read.isError, read.text).not.toBe(true);
  expect(calls).toEqual(['/v1/speech-engine/seng_source/duplicate', '/v1/speech-engine/seng_new']);
});

it.each(writes)('$id emits its own unavailable retry reason after one lost response', async row => {
  const op = await getOperation(row.id);
  expect(op.retry_check).toHaveProperty('unavailable_reason');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Synthetic connection loss'));
  const result = await pair.callTool(tool(row.profile), args(row));
  expect(result.isError).toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(result.text).toContain((op.retry_check as { unavailable_reason: string }).unavailable_reason);
  expect(result.text).toContain('No automatic retry');
  if (row.id === 'duplicate_speech_engine') {
    expect(result.text).toContain('source, not the new copy');
    expect(result.text).not.toContain('Check the result with get_speech_engine');
  }
});

it.each([undefined, null, {}, { name: null }])('preserves the optional duplicate body %j', async body => {
  const row = cases.find(item => item.id === 'duplicate_speech_engine')!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(row.response, { status: 201 }));
  const result = await pair.callTool(tool(row.profile), { ...args(row), body });
  expect(result.isError, result.text).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][1]?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
});

it('continues speech engine inventory explicitly and enforces the pinned page-size maximum', async () => {
  const row = cases.find(item => item.id === 'list_speech_engines')!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(row.response));
  const first = await pair.callTool(tool(row.profile), args(row));
  expect(first.isError, first.text).not.toBe(true); expect(receipt(first.text).has_more).toBe(true);
  expect(receipt(first.text).next).toContain('query_params.cursor'); expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValueOnce(Response.json({ speech_engines: [], next_cursor: null, has_more: false }));
  const second = await pair.callTool(tool(row.profile), { ...args(row), query_params: { page_size: 100, cursor: data(first.text).next_cursor } });
  expect(second.isError, second.text).not.toBe(true); expect(receipt(second.text).next).toBeUndefined();
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('cursor')).toBe('next engine/+?');
  const refused = await pair.callTool(tool(row.profile), { ...args(row), query_params: { page_size: 101 } });
  expect(refused.isError).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(cases)('$id refuses every other profile and all file bindings before dispatch', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const profiles = ['read_resource', 'create_resource', 'change_resource', 'delete_resource', 'run_job', 'run_agent_tests', 'query_knowledge', 'place_call'];
  for (const profile of profiles.filter(profile => `elevenlabs_${profile}` !== tool(row.profile))) {
    const refused = await pair.callTool(`elevenlabs_${profile}`, args(row));
    expect(refused.isError).toBe(true); expect(refused.text).toContain('WRONG_TOOL');
  }
  const files = await pair.callTool(tool(row.profile), { ...args(row), files: [{ field: 'asset', file_path: '/tmp/never-read' }] });
  expect(files.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
});
it('exempts only the exact credential locator names while literal header values remain secrets', () => {
  expect([...credentialIdentifiers].sort()).toEqual(['auth_connection_id', 'credential_id', 'env_var_label', 'secret_id', 'variable_name', 'workspace_api_key_id']);
  const secrets = sensitiveValues({ speech_engine: { request_headers: {
    'X-Dynamic': { variable_name: 'customer_region' }, 'X-Reference': { secret_id: 'secret_reference' },
    variable_name: 'literal-variable-header', secret_id: 'literal-secret-header',
    'X-Nested': { variable_name: { token: 'nested-secret-value' } },
  } } }, [['speech_engine', 'request_headers', '*']]);
  expect(secrets.sort()).toEqual(['literal-secret-header', 'literal-variable-header', 'nested-secret-value']);
});

it('returns a stored token-bearing ws_url wrapped on a read without submitted configuration', async () => {
  const row = cases.find(item => item.id === 'get_speech_engine')!;
  const ws_url = 'wss://transcripts.example.com/socket?token=stored-synthetic-token';
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ...row.response, speech_engine: { ...row.response!.speech_engine, ws_url } }));
  const result = await pair.callTool(tool(row.profile), args(row));
  expect(result.isError, result.text).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(data(result.text).speech_engine.ws_url).toBe(ws_url);
  expect(receipt(result.text).data).toMatch(/^<untrusted-content source="elevenlabs:api:get_speech_engine">/);
});
