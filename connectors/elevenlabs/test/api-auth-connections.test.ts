import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import { setApiKey } from '../src/auth.js';
import { getOperation, type ApiProfile } from '../src/api-catalog.js';
import { sensitiveValues } from '../src/api-sensitive.js';
import { validateRequest } from '../src/api-validation.js';
import { createRedactor } from '../src/api-sensitive.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import policy from '../api/operation-policy.json' with { type: 'json' };
import cases from './fixtures/api-auth-connections-wire-cases.json' with { type: 'json' };
import { mswServer } from './helpers/setup.js';

const writes = [
  ...cases.create.map(row => ({ ...row, id: 'create_auth_connection', method: 'POST', path: '/v1/workspace/auth-connections' })),
  ...cases.update.map(row => ({ ...row, id: 'update_auth_connection', method: 'PATCH', path: '/v1/workspace/auth-connections/connection_example' })),
];
const args = (row: typeof writes[number]) => ({ operation_id: row.id, body: row.body,
  ...(row.method === 'PATCH' ? { path_params: { auth_connection_id: 'connection_example' } } : {}) });
const data = (text: string) => JSON.parse(unwrapUntrusted(JSON.parse(text).data));
function values(body: object, paths: string[][]): string[] {
  const entries = body as Record<string, unknown>;
  return paths.flatMap(([key, wildcard]) => wildcard ? Object.values(entries[key] as object) as string[] : [entries[key] as string]);
}
function hidden(body: object, paths: string[][]): Record<string, unknown> {
  const copy = structuredClone(body) as Record<string, unknown>;
  for (const [key, wildcard] of paths) copy[key] = wildcard
    ? Object.fromEntries(Object.keys(copy[key] as object).map(name => [name, '[REDACTED]'])) : '[REDACTED]';
  return copy;
}
let pair: McpTestClient;
beforeEach(async () => {
  setApiKey('canary-connector-key-0001');
  for (const name of ['error', 'warn', 'log'] as const) vi.spyOn(console, name).mockImplementation(() => {});
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => { await pair.close(); setApiKey(''); vi.restoreAllMocks(); });
function noSecrets(text: string, secrets: string[]) {
  const logs = JSON.stringify(['error', 'warn', 'log'].flatMap(name => vi.mocked(console[name as 'error']).mock.calls));
  for (const value of [...secrets, 'canary-connector-key-0001']) {
    expect(text).not.toContain(value);
    expect(text).not.toContain(encodeURIComponent(value));
    expect(logs).not.toContain(value);
    expect(logs).not.toContain(encodeURIComponent(value));
  }
}

it.each(writes)('$schema forwards exact JSON once and protects every submitted secret in receipts and diagnostics', async row => {
  const op = await getOperation(row.id);
  const secrets = values(row.body, row.secret_paths);
  for (const path of row.secret_paths) expect(op.sensitive_request_fields).toContainEqual(path);
  expect(sensitiveValues(row.body, op.sensitive_request_fields!)).toEqual(expect.arrayContaining(secrets));
  const response = cases.responses.find(item => item.schema === row.response_schema)!;
  const echoed = { ...response.body, ...('token_url' in row.body ? { token_url: row.body.token_url } : {}),
    diagnostic: secrets.flatMap(value => [value, encodeURIComponent(value)]).join(' | ') };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(echoed));
  const result = await pair.callTool('elevenlabs_change_resource', args(row));
  expect(result.isError, result.text).not.toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  expect(String(fetch.mock.calls[0][0])).toBe(`https://api.elevenlabs.io${row.path}`);
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: row.method, redirect: 'manual', body: JSON.stringify(row.body) });
  const expected = hidden(response.body, response.secret_paths);
  if ('token_url' in row.body) expected.token_url = '[REDACTED]';
  expect(data(result.text)).toEqual({ ...expected, diagnostic: secrets.map(() => '[REDACTED] | [REDACTED]').join(' | ') });
  expect(JSON.parse(result.text)).toMatchObject({ status: 200, response_contract: 'matched', effects: {
    readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
  }, message: 'The provider returned a success response.' });
  noSecrets(result.text, [...secrets, ...values(response.body, response.secret_paths)]);
  for (const status of [400, 401, 403, 422, 500]) {
    const detail = secrets.flatMap(value => [value, encodeURIComponent(value)]).join(' | ');
    fetch.mockResolvedValueOnce(Response.json({ detail: status === 422 ? [{ loc: ['body', detail], msg: detail, input: detail }] : detail }, { status }));
    const error = await pair.callTool('elevenlabs_change_resource', args(row));
    expect(error.isError).toBe(true); expect(error.text).toContain('[REDACTED]');
    noSecrets(error.text, secrets);
  }
  expect(fetch).toHaveBeenCalledTimes(6);
});

it.each(cases.responses)('$schema hides stored maps on list, create and update while retaining exact metadata', async row => {
  const expected = hidden(row.body, row.secret_paths);
  const secrets = values(row.body, row.secret_paths);
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const id of ['create_auth_connection', 'update_auth_connection', 'list_auth_connections']) {
    fetch.mockResolvedValueOnce(Response.json(id === 'list_auth_connections' ? { auth_connections: [row.body] } : row.body));
    const input = id === 'list_auth_connections' ? { operation_id: id } : args(writes.find(item => item.id === id)!);
    const result = await pair.callTool(id === 'list_auth_connections' ? 'elevenlabs_read_resource' : 'elevenlabs_change_resource', input);
    expect(result.isError, result.text).not.toBe(true);
    expect(JSON.parse(result.text).response_contract).toBe('matched');
    expect(data(result.text)).toEqual(id === 'list_auth_connections' ? { auth_connections: [expected] } : expected);
    noSecrets(result.text, secrets);
    expect(data(result.text)[id === 'list_auth_connections' ? 'auth_connections' : 'status']).toBeDefined();
  }
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(writes)('$schema validates nullable updates and refuses invalid credentials before HTTP', async row => {
  await expect(validateRequest('change', args(row), createRedactor([]))).resolves.toBeDefined();
  if (row.method === 'PATCH') {
    const nullable = { ...row.body, ...Object.fromEntries(Object.keys(row.body).filter(key => key !== 'auth_type').map(key => [key, null])) };
    await expect(validateRequest('change', { ...args(row), body: nullable }, createRedactor([]))).resolves.toBeDefined();
  }
  const fetch = vi.spyOn(globalThis, 'fetch');
  const [key, wildcard] = row.secret_paths[0];
  const invalid = { ...row.body, [key]: wildcard ? { 'X-Anything': {} } : {} };
  const refused = await pair.callTool('elevenlabs_change_resource', { ...args(row), body: invalid });
  expect(refused.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
});

it('keeps all schema alternatives and explicit secret paths tied to the immutable pin', async () => {
  expect(cases.create).toHaveLength(7); expect(cases.update).toHaveLength(4); expect(cases.responses).toHaveLength(13);
  const source = process.env.ELEVENLABS_OPENAPI_SPEC;
  if (!source) return;
  const bytes = await readFile(source);
  const spec = JSON.parse((bytes[0] === 0x1f ? gunzipSync(bytes) : bytes).toString('utf8'));
  const path = spec.paths['/v1/workspace/auth-connections'];
  const update = spec.paths['/v1/workspace/auth-connections/{auth_connection_id}'].patch;
  const names = (branches: { $ref: string }[]) => branches.map(branch => branch.$ref.split('/').at(-1));
  expect(names(path.post.requestBody.content['application/json'].schema.anyOf)).toEqual(cases.create.map(row => row.schema));
  expect(names(update.requestBody.content['application/json'].schema.anyOf)).toEqual(cases.update.map(row => row.schema));
  expect(names(path.post.responses['200'].content['application/json'].schema.oneOf)).toEqual(cases.responses.map(row => row.schema));
  expect(names(update.responses['200'].content['application/json'].schema.oneOf)).toEqual(cases.responses.map(row => row.schema));
  expect(names(spec.components.schemas.ListAuthConnectionsResponse.properties.auth_connections.items.oneOf)).toEqual(cases.responses.map(row => row.schema));
  for (const row of [...cases.create, ...cases.update, ...cases.responses]) {
    const properties = spec.components.schemas[row.schema].properties;
    const sensitive = Object.keys(properties).filter(key => ['client_secret', 'password', 'token', 'secret_key', 'client_key', 'key_passphrase', 'client_certificate', 'ca_certificate', 'custom_headers', 'extra_headers', 'extra_params', ...('body' in row && cases.create.some(item => item.schema === row.schema) ? ['token_url'] : [])].includes(key));
    expect(row.secret_paths.map(path => path[0]).sort(), row.schema).toEqual(sensitive.sort());
  }
});

const operations = [
  { id: 'create_auth_connection', profile: 'change', input: args(writes[0]) },
  { id: 'update_auth_connection', profile: 'change', input: args(writes[7]) },
  { id: 'delete_auth_connection', profile: 'delete', input: { operation_id: 'delete_auth_connection', path_params: { auth_connection_id: 'connection_example' } } },
  { id: 'list_auth_connections', profile: 'read', input: { operation_id: 'list_auth_connections' } },
];
it.each(operations)('$id has truthful discovery and receipt semantics and no credential-return exemption', async row => {
  const op = await getOperation(row.id);
  expect(op).not.toHaveProperty('credential_return_fields');
  expect(policy.operations[row.id as keyof typeof policy.operations]).not.toHaveProperty('credential_return_fields');
  expect(op.timeout).toBe('standard'); expect(op.profile).toBe(row.profile);
  const discovery = await pair.callTool('elevenlabs_discover_api', { operation_id: row.id });
  expect(discovery.isError, discovery.text).not.toBe(true);
  if (row.profile === 'change') {
    expect(discovery.text).toContain('only that the provider stored');
    expect(discovery.text).toContain('not that they work');
    expect(op.retry_check).toHaveProperty('unavailable_reason');
  } else if (row.profile === 'delete') {
    expect(discovery.text).toContain('used_by'); expect(discovery.text).toContain('exact ID is absent');
    expect(op.responses).toEqual([expect.objectContaining({ status: 200, media_type: 'application/json', schema: {} })]);
  } else expect(discovery.text).toContain('not a token or password getter');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Synthetic connection loss'));
  const failure = await pair.callTool(`elevenlabs_${row.profile}_resource`, row.input);
  expect(failure.isError).toBe(true); expect(fetch).toHaveBeenCalledOnce();
  if (row.profile === 'change') expect(failure.text).toContain((op.retry_check as { unavailable_reason: string }).unavailable_reason);
  else expect(failure.text).toContain('list_auth_connections');
  expect(failure.text).toContain('No automatic retry');
});

it('preserves used_by before deleting, accepts unconstrained delete JSON and checks exact ID absence', async () => {
  const response = cases.responses[0];
  const calls: string[] = [];
  let deleted = false;
  mswServer.use(http.all('https://api.elevenlabs.io/*', ({ request }) => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    if (request.method === 'DELETE') { deleted = true; return HttpResponse.json(['arbitrary', { removed: true }]); }
    return HttpResponse.json({ auth_connections: deleted ? [{ ...response.body, id: 'connection_other' }] : [response.body] });
  }));
  const before = await pair.callTool('elevenlabs_read_resource', operations[3].input);
  expect(data(before.text).auth_connections[0].used_by).toEqual(response.body.used_by);
  const removed = await pair.callTool('elevenlabs_delete_resource', operations[2].input);
  expect(removed.isError, removed.text).not.toBe(true);
  expect(data(removed.text)).toEqual(['arbitrary', { removed: true }]);
  expect(JSON.parse(removed.text).next_step).toContain('list_auth_connections');
  const after = await pair.callTool('elevenlabs_read_resource', operations[3].input);
  expect(data(after.text).auth_connections.map((item: { id: string }) => item.id)).toEqual(['connection_other']);
  expect(calls).toEqual(['GET /v1/workspace/auth-connections', 'DELETE /v1/workspace/auth-connections/connection_example', 'GET /v1/workspace/auth-connections']);
});

it.each(operations)('$id refuses all wrong profiles with zero requests', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const profile of ['read', 'create', 'change', 'delete', 'run_job', 'tests', 'query_knowledge', 'place_call'] as ApiProfile[]) {
    if (profile === row.profile) continue;
    const tool = ['read', 'create', 'change', 'delete'].includes(profile) ? `${profile}_resource` : profile === 'tests' ? 'run_agent_tests' : profile;
    const result = await pair.callTool(`elevenlabs_${tool}`, row.input);
    expect(result.isError).toBe(true); expect(result.text).toContain('WRONG_TOOL'); expect(fetch).not.toHaveBeenCalled();
  }
});
