import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import { setApiKey } from '../src/auth.js';
import { API_TOOLS, getOperation, loadApiCatalog, validateApiCatalog, type ApiProfile } from '../src/api-catalog.js';
import { createRedactor, sensitiveValues } from '../src/api-sensitive.js';
import { isCredentialKey } from '../src/api-credential-keys.mjs';
import { apiCatalog } from '../src/generated/api-catalog.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import { compileCatalog, loadCoverageRosters, PINNED_SOURCE, validatePolicy } from '../scripts/generate-api-catalog.mjs';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import cases from './fixtures/api-workspace-access-wire-cases.json' with { type: 'json' };

const key = 'canary-connector-key-0001';
const secret = 'canary-secret-0001';
const root = resolve(import.meta.dirname, '..');
const rosters = await loadCoverageRosters(root);
const create = cases.find(row => row.id === 'create_workspace_webhook_route')!;
const edit = cases.find(row => row.id === 'edit_workspace_webhook_route')!;
const metadata = cases.find(row => row.id === 'get_resource_metadata')!;
const list = cases.find(row => row.id === 'get_workspace_webhooks_route')!;
const unique = [...new Map(cases.map(row => [row.id, row])).values()];
type Wire = typeof cases[number];
const input = (row: Wire) => ({ operation_id: row.id, ...row.args });
const data = (text: string) => JSON.parse(unwrapUntrusted(JSON.parse(text).data));
const logs = () => JSON.stringify(['error', 'warn', 'log'].flatMap(name => vi.mocked(console[name as 'error']).mock.calls));
function absent(text: string, secrets: string[]) {
  for (const value of [...secrets, key]) for (const spelling of [value, encodeURIComponent(value)]) {
    expect(text).not.toContain(spelling); expect(logs()).not.toContain(spelling);
  }
}
let pair: McpTestClient;
beforeEach(async () => {
  setApiKey(key);
  for (const name of ['error', 'warn', 'log'] as const) vi.spyOn(console, name).mockImplementation(() => {});
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => { await pair.close(); setApiKey(''); vi.restoreAllMocks(); });

it.each(cases)('$id / $case forwards the literal request once and preserves readable data', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(row.response));
  const result = await pair.callTool(API_TOOLS[row.profile as ApiProfile], input(row));
  expect(result.isError, result.text).not.toBe(true);
  expect(JSON.parse(result.text)).toMatchObject({ response_contract: 'matched', status: 200 });
  expect(data(result.text)).toEqual(row.response);
  expect(fetch).toHaveBeenCalledOnce();
  expect(String(fetch.mock.calls[0][0])).toBe(row.url);
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: row.method, redirect: 'manual' });
  expect(fetch.mock.calls[0][1]?.body).toBe(row.args.body ? JSON.stringify(row.args.body) : undefined);
  expect(logs()).not.toContain(secret);
  const { data: _data, ...summary } = JSON.parse(result.text);
  expect(JSON.stringify(summary)).not.toContain(secret);
  if (row.id === create.id) expect(result.text.split(secret)).toHaveLength(2);
});

it('keeps the workspace API key identifier readable while matching raw credentials under any name', () => {
  expect(isCredentialKey('workspace_api_key_id')).toBe(false);
  const body = { workspace_api_key_id: 'workspace_key_example' };
  expect(sensitiveValues(body, [])).toEqual([]);
  expect(createRedactor([key]).redact({ ...body, arbitrary_name: key, echo: encodeURIComponent(key) }))
    .toEqual({ ...body, arbitrary_name: '[REDACTED]', echo: '[REDACTED]' });
});

it('preserves identifier requests but masks a real-shaped synthetic API-key value even under an identifier name', async () => {
  const row = cases.find(row => row.id === 'share_resource_endpoint' && row.case === 'key')!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ workspace_api_key_id: key, other: key }));
  const result = await pair.callTool('elevenlabs_change_resource', input(row));
  expect(result.isError).not.toBe(true);
  expect(data(result.text)).toEqual({ workspace_api_key_id: '[REDACTED]', other: '[REDACTED]' });
  expect(fetch.mock.calls[0][1]?.body).toBe(JSON.stringify(row.args.body));
  expect(fetch).toHaveBeenCalledOnce(); absent(result.text, [key]);
});

it.each([create, edit])('$id collects arbitrary header values and masks raw and encoded echoes everywhere', async row => {
  const op = await getOperation(row.id);
  const secrets = row.id === create.id
    ? [create.args.body!.settings!.request_headers['X-Anything'], create.args.body!.settings!.webhook_url]
    : [edit.args.body!.request_headers!['X-Anything']];
  expect(op.sensitive_request_fields).toContainEqual(row.id === create.id ? ['settings', 'request_headers', '*'] : ['request_headers', '*']);
  expect(sensitiveValues(row.args.body, op.sensitive_request_fields!)).toEqual(expect.arrayContaining(secrets));
  const echo = secrets.flatMap(value => [value, encodeURIComponent(value)]).concat(key, encodeURIComponent(key));
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ...row.response, echo,
    ...(row.id === create.id ? { webhook_secret: `${secret}|${echo.join('|')}` } : {}) }));
  const result = await pair.callTool('elevenlabs_change_resource', input(row));
  expect(result.isError, result.text).not.toBe(true);
  absent(result.text, secrets);
  expect(data(result.text).echo).toEqual(echo.map(() => '[REDACTED]'));
  if (row.id === create.id) expect(data(result.text).webhook_secret).toBe(`${secret}|${echo.map(() => '[REDACTED]').join('|')}`);
  for (const status of [400, 401, 403, 422, 500]) {
    const detail = [...echo, secret].join(' | ');
    fetch.mockResolvedValueOnce(Response.json({ detail: status === 422 ? [{ loc: ['body', detail], msg: detail, input: detail }] : detail }, { status }));
    const failure = await pair.callTool('elevenlabs_change_resource', input(row));
    expect(failure.isError).toBe(true); absent(failure.text, secrets);
    if (row.id === create.id) absent(failure.text, [secret]);
  }
  expect(fetch).toHaveBeenCalledTimes(6);
  fetch.mockRejectedValueOnce(new TypeError(echo.join(' | ')));
  const network = await pair.callTool('elevenlabs_change_resource', input(row));
  expect(network.isError).toBe(true); absent(network.text, secrets);
});

it.each([null, undefined, key, 'canary-header /+0001'])('preserves nullable/absent signing secrets and redacts submitted secret %j', async value => {
  const response = { webhook_id: 'webhook_example', ...(value === undefined ? {} : { webhook_secret: value }) };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response));
  const result = await pair.callTool('elevenlabs_change_resource', input(create));
  expect(result.isError, result.text).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(data(result.text)).toEqual({ webhook_id: 'webhook_example', ...(value === undefined ? {} : { webhook_secret: value === null ? null : '[REDACTED]' }) });
  absent(result.text, [key, 'canary-header /+0001']);
});

it('returns the signing secret only at creation and preserves list state and auth metadata without fetching destinations', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(create.response)).mockResolvedValueOnce(Response.json(list.response));
  const issued = await pair.callTool('elevenlabs_change_resource', input(create));
  expect(data(issued.text).webhook_secret).toBe(secret);
  const stored = await pair.callTool('elevenlabs_read_resource', input(list));
  expect(data(stored.text)).toEqual(list.response); absent(stored.text, [secret]);
  expect(stored.text).toContain('untrusted-content'); expect(fetch).toHaveBeenCalledTimes(2);
  for (const row of unique) {
    const discovery = await pair.callTool('elevenlabs_discover_api', { operation_id: row.id });
    expect(discovery.isError).not.toBe(true); absent(discovery.text, [secret]);
  }
  for (const auth_type of ['oauth2', 'mtls']) {
    const response = { webhooks: [{ ...list.response.webhooks![0], auth_type }] };
    fetch.mockResolvedValueOnce(Response.json(response));
    expect(data((await pair.callTool('elevenlabs_read_resource', input(list))).text)).toEqual(response);
  }
});

it('refuses missing metadata query and both missing required edit fields without dispatch', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const missingQuery = await pair.callTool('elevenlabs_read_resource', { operation_id: metadata.id, path_params: metadata.args.path_params });
  expect(missingQuery.isError).toBe(true);
  for (const field of ['is_disabled', 'name']) {
    const body = { ...edit.args.body } as Record<string, unknown>; delete body[field];
    const refused = await pair.callTool('elevenlabs_change_resource', { ...input(edit), body });
    expect(refused.isError).toBe(true);
  }
  const refusedAuth = await pair.callTool('elevenlabs_change_resource', { ...input(create), body: { settings: { ...create.args.body!.settings, auth_type: 'oauth2' } } });
  expect(refusedAuth.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
});

it('overwrites then removes the exact group role and discloses the creator restriction', async () => {
  const grants: Record<string, string[]> = { editor: ['group_example'] };
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'GET') return Response.json({ ...metadata.response, role_to_group_ids: grants });
    const body = JSON.parse(String(init?.body));
    for (const members of Object.values(grants)) { const i = members.indexOf(body.group_id); if (i >= 0) members.splice(i, 1); }
    if (body.role) (grants[body.role] ??= []).push(body.group_id);
    return Response.json({ status: 'ok' });
  });
  for (const row of cases.filter(row => row.case === 'group')) {
    const result = await pair.callTool(API_TOOLS[row.profile as ApiProfile], input(row));
    expect(result.isError).not.toBe(true);
    const state = data((await pair.callTool('elevenlabs_read_resource', input(metadata))).text);
    expect(state.role_to_group_ids).toEqual(row.profile === 'change' ? { editor: [], viewer: ['group_example'] } : { editor: [], viewer: [] });
  }
  expect(fetch).toHaveBeenCalledTimes(4);
  const op = await getOperation('unshare_resource_endpoint');
  expect(op.effect_note).toContain("creator's access cannot be removed");
  const discovery = await pair.callTool('elevenlabs_discover_api', { operation_id: op.operation_id });
  expect(discovery.text).toContain("creator's access cannot be removed");
});

it.each(unique)('$id has the reviewed profile/effects, standard timeout and truthful retry guidance', async row => {
  const op = await getOperation(row.id);
  expect(op).toMatchObject({ profile: row.profile, timeout: 'standard', effects: {
    readOnlyHint: row.profile === 'read', destructiveHint: row.profile !== 'read', idempotentHint: row.profile === 'read', openWorldHint: true,
  } });
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Synthetic lost response'));
  const failure = await pair.callTool(API_TOOLS[row.profile as ApiProfile], input(row));
  expect(failure.isError).toBe(true); expect(fetch).toHaveBeenCalledOnce();
  if (row.profile === 'read') {
    expect(op.retry_check).toBe(row.id);
    expect(failure.text).toContain(`Check the result with ${row.id}`);
    expect(failure.text).not.toContain('No verifiable lookup');
    expect(failure.text).not.toContain('Do not blindly retry');
  } else if (row.id === 'delete_workspace_webhook_route') {
    expect(op.retry_check).toBe(list.id); expect(failure.text).toContain(list.id); expect(op.effect_note).toContain('exact webhook ID is absent');
  } else {
    expect(op.retry_check).toHaveProperty('unavailable_reason');
    expect(failure.text).toContain((op.retry_check as { unavailable_reason: string }).unavailable_reason);
    expect(failure.text).toContain('No verifiable lookup'); expect(failure.text).not.toContain('Check the result with');
  }
  absent(failure.text, [secret]);
});

it.each(unique)('$id refuses every other profile with zero requests', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const profile of ['read', 'create', 'change', 'delete', 'tests', 'query_knowledge', 'run_job', 'place_call'] as ApiProfile[]) {
    if (profile === row.profile) continue;
    const refused = await pair.callTool(API_TOOLS[profile], input(row));
    expect(refused.isError).toBe(true);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('requires explicit issuing declarations and rejects undeclared returns in generator and runtime', async () => {
  const policy = structuredClone(policyInput);
  Object.assign(policy.operations.get_resource_metadata, { credential_return_fields: [['resource_id']] });
  expect(() => validatePolicy(policy, rosters)).toThrow('credential return requires declared issuer');
  const missing = structuredClone(policyInput); delete (missing.credential_issuers as Record<string, string>)[create.id];
  expect(() => validatePolicy(missing, rosters)).toThrow('credential return requires declared issuer');
  const catalog = structuredClone(validateApiCatalog(apiCatalog));
  catalog.operations.find(op => op.operation_id === metadata.id)!.credential_return_fields = [['resource_id']];
  expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({
    code: 'CATALOG_INVALID',
    issues: [expect.objectContaining({ message: 'Credential return requires declared issuer or schema-declared signed media.' })],
  }));
  const issuers = Object.keys(policyInput.credential_issuers);
  for (const id of issuers) expect((await getOperation(id)).credential_return_fields).toEqual(policyInput.operations[id as keyof typeof policyInput.operations].credential_return_fields);
  if (process.env.ELEVENLABS_OPENAPI_SPEC) expect(() => compileCatalog(readFileBytes!, policy, PINNED_SOURCE, rosters)).toThrow('credential return requires declared issuer');
});

const readFileBytes = process.env.ELEVENLABS_OPENAPI_SPEC ? await readFile(process.env.ELEVENLABS_OPENAPI_SPEC) : undefined;
it.skipIf(!readFileBytes)('ties exact secret and issuer paths to the pin and preserves the HMAC-only creation schema', async () => {
  const pin = JSON.parse(gunzipSync(readFileBytes!).toString());
  const schemas = pin.components.schemas;
  expect(schemas.Body_Create_workspace_webhook_v1_workspace_webhooks_post.properties.settings.$ref).toBe('#/components/schemas/WebhookHMACSettings');
  expect(schemas.WebhookHMACSettings.properties.auth_type.const).toBe('hmac');
  expect(schemas.WebhookHMACSettings.properties.request_headers.anyOf[0].additionalProperties.type).toBe('string');
  expect(schemas.WorkspaceCreateWebhookResponseModel.required).toEqual(['webhook_id']);
  expect(schemas.WorkspaceCreateWebhookResponseModel.properties.webhook_secret.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
  expect((await getOperation(create.id)).credential_return_fields).toEqual([['webhook_secret']]);
  expect((await getOperation(create.id)).sensitive_request_fields).toEqual([['settings', 'webhook_url'], ['settings', 'request_headers', '*']]);
  expect((await getOperation(edit.id)).sensitive_request_fields).toEqual([['request_headers', '*']]);
  expect(schemas.WorkspaceWebhookResponseModel.properties).not.toHaveProperty('webhook_secret');
  expect((await loadApiCatalog()).operations).toHaveLength(402);
});
