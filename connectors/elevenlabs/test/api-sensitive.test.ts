import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setApiKey } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { discoverOperations, loadApiCatalog, validateApiCatalog } from '../src/api-catalog.js';
import { validateRequest } from '../src/api-validation.js';
import { apiCatalog } from '../src/generated/api-catalog.js';
import { compileCatalog, loadCoverageRosters, PINNED_SOURCE, validatePolicy } from '../scripts/generate-api-catalog.mjs';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import cases from './fixtures/api-sensitive-wire-cases.json' with { type: 'json' };
import { mswServer } from './helpers/setup.js';

const root = resolve(import.meta.dirname, '..');
const rosters = await loadCoverageRosters(root);
const secret = 'example-secret-value';
const marker = '[REDACTED]';
let pair: McpTestClient;
let requests = 0;
const count = () => requests++;
beforeEach(async () => {
  setApiKey('example-connector-credential');
  requests = 0;
  mswServer.events.on('request:start', count);
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => {
  await pair.close();
  mswServer.events.removeListener('request:start', count);
  setApiKey('');
  vi.restoreAllMocks();
});

describe('sensitive family contracts', () => {
  it('admits exactly 24 contracts with callable distinct follow-ups and GET retry checks', async () => {
    expect(cases).toHaveLength(24);
    const catalog = await loadApiCatalog();
    expect(catalog.operations.filter(op => ['secrets', 'environment-variables', 'mcp-servers'].includes(op.family)).map(op => op.operation_id).sort())
      .toEqual(cases.map(wire => wire.id).sort());
    for (const wire of cases) {
      const op = catalog.operations.find(op => op.operation_id === wire.id)!;
      expect(op.deprecated).toBe(wire.id === 'update_mcp_server_approval_policy_route');
      expect(catalog.operations.find(read => read.operation_id === op.check_before_retry)).toMatchObject({ method: 'GET', profile: 'read' });
      const description = await discoverOperations({ operation_id: wire.id });
      expect(description.contract).toContain(op.summary);
      if (wire.profile === 'read') for (const name of op.parameters.path.required) expect(op.summary).toContain(name);
      for (const id of op.follow_ups) {
        expect(id).not.toBe(op.operation_id);
        const read = catalog.operations.find(read => read.operation_id === id)!;
        await expect(validateRequest('read', { operation_id: id, path_params: Object.fromEntries(read.parameters.path.required.map(name => [name, 'example_id'])) }))
          .resolves.toMatchObject({ operation_id: id });
      }
    }
  });

  it('discloses approval changes, external contacts, deletion impact and deprecation', async () => {
    for (const operation_id of ['create_mcp_server_route', 'update_mcp_server_config_route', 'update_mcp_server_approval_policy_route', 'add_mcp_server_tool_approval_route']) {
      const description = await discoverOperations({ operation_id });
      expect(description).toMatchObject({ profile: 'change', effects: { destructiveHint: true } });
      expect(description.instructions.toLowerCase()).toContain('changes which tools run without approval');
      if (operation_id === 'create_mcp_server_route' || operation_id === 'update_mcp_server_config_route') expect(description.instructions).toContain('provider will contact that URL');
    }
    expect(await discoverOperations({ operation_id: 'delete_environment_variable' })).toHaveProperty('instructions', expect.stringContaining('conversations then fail'));
    expect(await discoverOperations({ operation_id: 'delete_secret_route' })).toHaveProperty('instructions', expect.stringContaining('only if it is not in use'));
    expect(await discoverOperations({ operation_id: 'update_mcp_server_approval_policy_route' })).toHaveProperty('contract', expect.stringContaining('"deprecated":true'));
  });

  it('requires the reviewed PATCH-delete declaration at generation and load time', () => {
    const policy = structuredClone(policyInput);
    delete (policy.operations.update_environment_variable as { reviewed_patch_delete?: string }).reviewed_patch_delete;
    expect(() => validatePolicy(policy, rosters)).toThrow('method effect floor');
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    delete catalog.operations.find(op => op.operation_id === 'update_environment_variable')!.reviewed_patch_delete;
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it.each(['get_agents_route', 'create_secret_route', 'update_secret_route', 'delete_secret_route'] as const)('refuses misplaced PATCH-delete review on %s', id => {
    const policy = structuredClone(policyInput);
    Object.assign(policy.operations[id], { reviewed_patch_delete: 'Only PATCH deletions have this review.' });
    expect(() => validatePolicy(policy, rosters)).toThrow('misplaced reviewed PATCH delete');
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    catalog.operations.find(op => op.operation_id === id)!.reviewed_patch_delete = 'Misplaced review.';
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it.each(['sensitive_request_fields', 'sensitive_response_fields'] as const)('refuses %s on planned and excluded operations', field => {
    for (const id of ['upload_file_route', 'redirect_to_mintlify'] as const) {
      const policy = structuredClone(policyInput);
      Object.assign(policy.operations[id], { [field]: [['value']] });
      expect(() => validatePolicy(policy, rosters)).toThrow('non-admitted transport metadata');
    }
  });

  it.each(['sensitive_request_fields', 'sensitive_response_fields'] as const)('refuses nonexistent, unbound wildcard and duplicate %s paths at runtime', field => {
    for (const paths of [[['not_a_field']], [['value', '*']], [['value'], ['value']]]) {
      const catalog = structuredClone(validateApiCatalog(apiCatalog));
      catalog.operations.find(op => op.operation_id === 'create_secret_route')![field] = paths;
      expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
    }
  });

  it.skipIf(!process.env.ELEVENLABS_OPENAPI_SPEC)('refuses invalid sensitive schema paths in the real pinned generator', async () => {
    const spec = await readFile(process.env.ELEVENLABS_OPENAPI_SPEC!);
    for (const [field, paths] of [
      ['sensitive_request_fields', [['not_a_field']]],
      ['sensitive_request_fields', [['value', '*']]],
      ['sensitive_request_fields', [['value'], ['value']]],
      ['sensitive_response_fields', [['value']]],
    ] as const) {
      const policy = structuredClone(policyInput);
      Object.assign(policy.operations.create_secret_route, { [field]: paths });
      expect(() => compileCatalog(spec, policy, PINNED_SOURCE, rosters)).toThrow(/(?:unbound|duplicate) sensitive field/);
    }
  });
});

const sensitiveWrites = cases.filter(wire => ['create_secret_route', 'update_secret_route', 'create_mcp_server_route', 'update_mcp_server_config_route'].includes(wire.id));
describe('write-only credentials on the real SDK wire', () => {
  it.each(sensitiveWrites)('$id sends credentials once and scrubs success echoes everywhere', async wire => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let body: unknown;
    const submitted = JSON.stringify(wire.body);
    const values = submitted.match(/example-[a-z-]*(?:value)/g)!;
    mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ...wire.response, echo: values, nested: { [values[0]]: `Echo ${values[0]}` } });
    }));
    const result = await pair.callTool(`elevenlabs_${wire.profile}_resource`, { operation_id: wire.id, ...wire.args });
    expect(result.isError, result.text).not.toBe(true);
    expect(body).toEqual(wire.body);
    expect(requests).toBe(1);
    expect(result.text).toContain(marker);
    for (const value of values) {
      expect(result.text).not.toContain(value);
      expect(JSON.stringify(log.mock.calls)).not.toContain(value);
    }
  });

  it.each(sensitiveWrites.flatMap(wire => [400, 422, 500].map(status => ({ wire, status }))))('$wire.id redacts an echoed HTTP $status error', async ({ wire, status }) => {
    const values = JSON.stringify(wire.body).match(/example-[a-z-]*(?:value)/g)!;
    let body: unknown;
    mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ detail: values.join(' ') }, { status });
    }));
    const result = await pair.callTool(`elevenlabs_${wire.profile}_resource`, { operation_id: wire.id, ...wire.args });
    expect(result.isError).toBe(true);
    expect(body).toEqual(wire.body);
    expect(requests).toBe(1);
    expect(result.text).toContain(marker);
    for (const value of values) expect(result.text).not.toContain(value);
  });

  it.each(sensitiveWrites)('$id hides credentials when a sibling field is invalid, including diagnostic paths', async wire => {
    const body = structuredClone(wire.body) as Record<string, unknown>;
    if (body.config) (body.config as Record<string, unknown>).name = 42;
    else if ('approval_policy' in body) body.approval_policy = 42;
    else body.name = 42;
    const args = { operation_id: wire.id, ...wire.args, body };
    const result = await pair.callTool(`elevenlabs_${wire.profile}_resource`, args);
    expect(result.json).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    for (const value of JSON.stringify(wire.body).match(/example-[a-z-]*(?:value)/g)!) expect(result.text).not.toContain(value);
    // The undeclared path key is a submitted credential, proving diagnostics are actually scrubbed.
    const credential = JSON.stringify(wire.body).match(/example-[a-z-]*(?:value)/)![0];
    const withEchoedPath = await pair.callTool(`elevenlabs_${wire.profile}_resource`, {
      operation_id: wire.id, ...wire.args, path_params: { ...wire.args.path_params, [credential]: 'invalid' },
    });
    expect(withEchoedPath.text).toContain(marker);
    expect(withEchoedPath.text).not.toContain(credential);
    expect(requests).toBe(0);
  });

  it.each(['example-secret-value', 'example-secret-"value"\n', 'example-secret-<untrusted-content>value</untrusted-content>'])('scrubs escaped spellings of %s', async value => {
    mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/secrets', () => HttpResponse.json({ detail: `Echo ${value} ${encodeURIComponent(value)} ${JSON.stringify(value)}` }, { status: 500 })));
    const result = await pair.callTool('elevenlabs_create_resource', { operation_id: 'create_secret_route', body: { type: 'new', name: 'Guide credential', value } });
    expect(result.text).toContain(marker);
    expect(result.text).not.toContain(value);
    expect(result.text).not.toContain(encodeURIComponent(value));
    expect(requests).toBe(1);
  });

  it.each(['get_mcp_route', 'list_mcp_servers_route'])('%s redacts literal read credentials without a submitted value', async operation_id => {
    const config = { name: 'Guide server', url: 'https://mcp.example.com/events', request_headers: { Authorization: secret, Reference: { secret_id: 'secret_reference' } }, request_meta: { credential: 'example-meta-secret-value' }, secret_token: { name: 'Guide credential', encrypted_value: 'example-encrypted-secret-value', nonce: 'example-nonce-value', id: 'secret_reference' } };
    const server = { id: 'mcp_example', config, metadata: { created_at: 1 } };
    mswServer.use(http.get('https://api.elevenlabs.io/*', () => HttpResponse.json(operation_id === 'get_mcp_route' ? server : { mcp_servers: [server] })));
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id, ...(operation_id === 'get_mcp_route' ? { path_params: { mcp_server_id: 'mcp_example' } } : {}) });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.json).toHaveProperty('response_contract', 'matched');
    for (const value of [secret, 'example-meta-secret-value', 'example-encrypted-secret-value', 'example-nonce-value']) expect(result.text).not.toContain(value);
    expect(result.text).toContain('secret_reference');
    expect(result.text).toContain(marker);
    expect(requests).toBe(1);
  });

  it.each(['get_mcp_route', 'list_mcp_servers_route'])('%s leaves IDs, URLs and policies intact when a stored header or meta value is short', async operation_id => {
    const config = { name: 'Guide server 1', url: 'https://mcp1.example.com/auto', approval_policy: 'auto_approve_all', request_headers: { 'X-Api-Version': '1' }, request_meta: { mode: 'auto' } };
    const server = { id: 'mcp_ab1c', config, metadata: { created_at: 1 } };
    mswServer.use(http.get('https://api.elevenlabs.io/*', () => HttpResponse.json(operation_id === 'get_mcp_route' ? server : { mcp_servers: [server] })));
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id, ...(operation_id === 'get_mcp_route' ? { path_params: { mcp_server_id: 'mcp_ab1c' } } : {}) });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.json).toHaveProperty('response_contract', 'matched');
    for (const intact of ['mcp_ab1c', 'Guide server 1', 'https://mcp1.example.com/auto', 'auto_approve_all', 'X-Api-Version']) expect(result.text).toContain(intact);
    expect(result.text).not.toMatch(/X-Api-Version\\?":\\?"1/);
    expect(result.text).toContain(marker);
    expect(requests).toBe(1);
  });
});
