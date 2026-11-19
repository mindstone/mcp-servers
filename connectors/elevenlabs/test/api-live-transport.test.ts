import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { http, HttpResponse } from 'msw';
import { compileCatalog, loadCoverageRosters } from '../scripts/generate-api-catalog.mjs';
import { validateApiCatalog, type ApiCatalog } from '../src/api-catalog.js';
import { apiCatalog } from '../src/generated/api-catalog.js';
import { extensionFromContentType } from '../src/client.js';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import miniInput from './fixtures/mini-openapi.json' with { type: 'json' };
import { mswServer } from './helpers/setup.js';

const rosters = await loadCoverageRosters(resolve(import.meta.dirname, '..'));
const ids = ['get_agents_route', 'create_agent_route', 'create_file_document_route', 'update_file_document_route'] as const;
function synthetic() {
  const spec = structuredClone(miniInput);
  const policy = { ...structuredClone(policyInput), operations: Object.fromEntries(ids.map(id => [id, { ...structuredClone(policyInput.operations[id]), follow_ups: [] }])) };
  policy.family_retry_checks = { agents: { read: 'get_agents_route' }, 'knowledge-base': { read: 'get_agents_route' } };
  return { spec, policy };
}
function compile({ spec, policy }: ReturnType<typeof synthetic>): ApiCatalog {
  const bytes = Buffer.from(JSON.stringify(spec));
  const source = { ...policy.source, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, paths: 4, operations: 4 };
  const compiled = compileCatalog(bytes, { ...policy, source }, source, rosters);
  // The runtime source metadata is pinned separately from these synthetic transport contracts.
  return { ...compiled, source: apiCatalog.source } as ApiCatalog;
}
function csvFixture() {
  const fixture = synthetic();
  fixture.spec.paths['/v1/convai/agents'].get.parameters = fixture.spec.paths['/v1/convai/agents'].get.parameters.filter(p => p.name !== 'cursor');
  Object.assign(fixture.spec.paths['/v1/convai/agents'].get.responses, {
    '200': { description: 'Synthetic CSV', content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } } },
  });
  return fixture;
}
function documentFixture() {
  const fixture = synthetic();
  fixture.spec.paths['/v1/convai/agents'].get.parameters = fixture.spec.paths['/v1/convai/agents'].get.parameters.filter(p => p.name !== 'cursor');
  fixture.spec.paths['/v1/convai/agents'].get.parameters.push({ name: 'last_doc', in: 'query', schema: { type: 'string' } });
  Object.assign(fixture.spec.paths['/v1/convai/agents'].get.responses, {
    '200': { description: 'Synthetic document page', content: { 'application/json': { schema: { type: 'object', properties: { has_more: { type: 'boolean' }, next_doc: { type: ['string', 'null'] } }, required: ['has_more', 'next_doc'] } } } },
  });
  Object.assign(fixture.policy.operations.get_agents_route, { manual_pagination: 'Pass data.next_doc as query_params.last_doc to the same operation. No pages are fetched automatically.' });
  return fixture;
}
afterEach(() => { vi.doUnmock('../src/generated/api-catalog.js'); vi.resetModules(); vi.unstubAllEnvs(); });

describe('synthetic future transport declarations', () => {
  it('preserves the declared CSV binary schema through generation and loading', () => {
    const catalog = compile(csvFixture());
    const loaded = validateApiCatalog(catalog);
    expect(loaded.operations.find(op => op.operation_id === 'get_agents_route')!.responses).toEqual([{ status: 200, media_type: 'text/csv', schema: { type: 'string', format: 'binary' } }]);
    expect(extensionFromContentType('text/csv; charset=utf-8')).toBe('csv');
  });

  it('refuses CSV without a binary schema, undeclared media and binary schemas in JSON at both boundaries', () => {
    for (const [media, schema] of [['text/csv', { type: 'string' }], ['application/octet-stream', { type: 'string', format: 'binary' }], ['application/json', { type: 'string', format: 'binary' }]] as const) {
      const fixture = synthetic();
      Object.assign(fixture.spec.paths['/v1/convai/agents'].get.responses, { '200': { description: 'Invalid media/schema', content: { [media]: { schema } } } });
      expect(() => compile(fixture)).toThrow();
      const catalog = compile(csvFixture());
      Object.assign(catalog.operations.find(op => op.operation_id === 'get_agents_route')!.responses[0], { media_type: media, schema });
      expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
    }
  });

  it('requires a reviewed manual last_doc/next_doc pair and keeps normalized pagination null', () => {
    const catalog = compile(documentFixture());
    const op = validateApiCatalog(catalog).operations.find(op => op.operation_id === 'get_agents_route')!;
    expect(op.pagination).toBeNull();
    expect(op.manual_pagination).toContain('Pass data.next_doc as query_params.last_doc');
    const fixture = documentFixture();
    delete (fixture.policy.operations.get_agents_route as { manual_pagination?: string }).manual_pagination;
    expect(() => compile(fixture)).toThrow('unsupported pagination');
    delete catalog.operations.find(op => op.operation_id === 'get_agents_route')!.manual_pagination;
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it.each(['last_doc', 'next_doc', 'has_more'])('refuses a partial document-token pair missing %s at both boundaries', missing => {
    const fixture = documentFixture();
    if (missing === 'last_doc') fixture.spec.paths['/v1/convai/agents'].get.parameters = fixture.spec.paths['/v1/convai/agents'].get.parameters.filter(p => p.name !== missing);
    else {
      Object.assign(fixture.spec.paths['/v1/convai/agents'].get.responses, { '200': { description: 'Partial pair', content: { 'application/json': { schema: { type: 'object', properties: missing === 'next_doc' ? { has_more: { type: 'boolean' } } : { next_doc: { type: 'string' } } } } } } });
    }
    expect(() => compile(fixture)).toThrow('invalid manual pagination');
    const catalog = compile(documentFixture());
    const op = catalog.operations.find(op => op.operation_id === 'get_agents_route')!;
    if (missing === 'last_doc') { delete op.parameters.query.properties.last_doc; delete op.parameters.query_serialization.last_doc; }
    else delete (op.responses[0].schema as { properties: Record<string, unknown> }).properties[missing];
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it.each([false, true])('refuses unsupported offset pagination with manual declaration %s at both boundaries', manual => {
    const fixture = documentFixture();
    fixture.spec.paths['/v1/convai/agents'].get.parameters.push({ name: 'offset', in: 'query', schema: { type: 'integer' } });
    if (!manual) delete (fixture.policy.operations.get_agents_route as { manual_pagination?: string }).manual_pagination;
    expect(() => compile(fixture)).toThrow(manual ? 'invalid manual pagination' : 'unsupported pagination');
    const catalog = compile(documentFixture());
    const op = catalog.operations.find(op => op.operation_id === 'get_agents_route')!;
    op.parameters.query.properties.offset = { type: 'integer' };
    op.parameters.query_serialization.offset = 'form-explode';
    if (!manual) delete op.manual_pagination;
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it('writes exact CSV bytes to a generated .csv artifact, ignoring provider filenames', async () => {
    vi.resetModules();
    const catalog = compile(csvFixture());
    vi.doMock('../src/generated/api-catalog.js', () => ({ apiCatalog: catalog }));
    const { executeApiOperation } = await import('../src/api-executor.js');
    const { setApiKey } = await import('../src/auth.js');
    const workspace = await mkdtemp(join(tmpdir(), 'elevenlabs-synthetic-csv-'));
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
    setApiKey('example-connector-credential');
    const bytes = Buffer.from([239, 187, 191, 97, 44, 98, 13, 10, 0, 128, 255]);
    const dispatch = vi.fn(() => new HttpResponse(bytes, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="../../untrusted.csv"' } }));
    mswServer.use(http.get('https://api.elevenlabs.io/v1/convai/agents', dispatch));
    try {
      const receipt = await executeApiOperation('read', { operation_id: 'get_agents_route' });
      expect(receipt.data).toBeNull();
      expect(receipt.artifact).toMatchObject({ file_path: expect.stringMatching(/elevenlabs_[a-f0-9-]+\.csv$/), size_bytes: bytes.length, media_type: 'text/csv' });
      expect(receipt.artifact!.file_path.startsWith(workspace)).toBe(true);
      expect(await readFile(receipt.artifact!.file_path)).toEqual(bytes);
      expect(JSON.stringify(receipt)).not.toContain('untrusted.csv');
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { setApiKey(''); await rm(workspace, { recursive: true, force: true }); }
  });
});
