import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import miniInput from './fixtures/mini-openapi.json' with { type: 'json' };
import effectExpectations from './fixtures/api-effect-expectations.json' with { type: 'json' };
import legacyTools from './fixtures/legacy-tools.json' with { type: 'json' };
import { apiCatalog as catalogData } from '../src/generated/api-catalog.js';
import {
  compileCatalog, generateArtifacts, loadCoverageRosters, matchesPrefix, originalBytes,
  PINNED_SOURCE, policySchema, renderCatalog, renderCoverage, SCHEMA_FORMATS,
  SCHEMA_METADATA_KEYWORDS, stableJson, validatePolicy, VALIDATOR_OPTIONS, verifySource,
} from '../scripts/generate-api-catalog.mjs';

const apiCatalog = catalogData as ReturnType<typeof compileCatalog>;
const root = resolve(import.meta.dirname, '..');
const rosters = await loadCoverageRosters(root);
const miniBytes = await readFile(resolve(root, 'test/fixtures/mini-openapi.json'));
const MINI_SOURCE = {
  url: 'https://example.com/mini-openapi.json', retrieved_at: '2026-11-08T00:00:00+00:00',
  sha256: '2dba79fbc66eff337779fe4713876837fa8261b1947ef3b85892cbd13de3e322',
  bytes: 14918, paths: 4, operations: 4,
};
const LIST_PATH = '/v1/convai/agents';
const CREATE_PATH = '/v1/convai/agents/create';
const FILE_PATH = '/v1/convai/knowledge-base/file';
const UPDATE_PATH = '/v1/convai/knowledge-base/{documentation_id}/update-file';
type Schema = Record<string, unknown>;
interface Parameter { name: string; in: string; required?: boolean; schema: Schema; style?: string; explode?: boolean }
interface Response { description: string; content?: Record<string, { schema?: Schema | boolean }> }
interface Operation {
  operationId: string; parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema; encoding?: Schema }> };
  responses: Record<string, Response>;
}
interface FixtureSpec {
  openapi: string; info: { title: string; version: string };
  paths: Record<string, Record<string, Operation | Parameter[]>>;
  components: { schemas: Record<string, Schema | boolean> };
}
function obj(value: unknown): Schema {
  z.record(z.unknown()).parse(value);
  return value as Schema;
}
function operation(spec: FixtureSpec, path: string, method: string): Operation {
  return spec.paths[path][method] as Operation;
}
function schema(spec: FixtureSpec, name: string): Schema { return obj(spec.components.schemas[name]); }
function miniPolicy(spec: FixtureSpec, source = MINI_SOURCE) {
  const operations = Object.fromEntries(Object.values(spec.paths).flatMap(path => Object.values(path)
    .filter((value): value is Operation => !Array.isArray(value))
    .map(value => {
      const row = structuredClone(policyInput.operations[value.operationId as keyof typeof policyInput.operations]);
      return [value.operationId, { ...row, follow_ups: [] }];
    })));
  return { ...structuredClone(policyInput), source, operations };
}
function compileMini() {
  return compileCatalog(miniBytes, miniPolicy(miniInput as unknown as FixtureSpec), MINI_SOURCE, rosters);
}
function descriptor(catalog: typeof apiCatalog, id: string) {
  const found = catalog.operations.find(row => row.operation_id === id);
  if (!found) throw new Error(`Missing descriptor: ${id}`);
  return found;
}

// Mutants have explicit fixture pins below. Neither this helper nor the CLI
// disables source verification, even when the input is deliberately unsupported.
const mutationCases = [
  { name: 'request media', hash: 'e42c20600f53d0e7684e8d43a7d99efaba79dbbef62f4891e5941ebdd4a4e699', expected: 'unsupported request media', mutate(spec: FixtureSpec) {
    operation(spec, CREATE_PATH, 'post').requestBody!.content = { 'application/xml': { schema: { type: 'string' } } };
  } },
  { name: 'multiple request media', hash: 'd86f739b3628c9fd4d8bd50abd4fda14bc87c9c96483780d5cebb77d10d2b915', expected: 'unsupported request media', mutate(spec: FixtureSpec) {
    operation(spec, CREATE_PATH, 'post').requestBody!.content['text/plain'] = { schema: { type: 'string' } };
  } },
  { name: 'header', hash: '1cb95d6c714753d676d134dd65bcb32f6e35c9fd577e3717d830a73ce1dc7b2b', expected: 'unsupported header parameter', mutate(spec: FixtureSpec) {
    operation(spec, LIST_PATH, 'get').parameters!.push({ name: 'x-session', in: 'header', schema: { type: 'string' } });
  } },
  { name: 'object query', hash: '15e3ef0f2f7e631b102f6965b8320b9aa587a214eeb8cf0f56faf1effac572f6', expected: 'non-scalar query', mutate(spec: FixtureSpec) {
    operation(spec, LIST_PATH, 'get').parameters!.push({ name: 'filter', in: 'query', schema: { type: 'object', additionalProperties: true } });
  } },
  { name: 'nested array query', hash: 'b2d12a066b1cce8e3ade5b0f1dc4ebf25028060b2cbb638529af4515826b393c', expected: 'non-scalar query', mutate(spec: FixtureSpec) {
    operation(spec, LIST_PATH, 'get').parameters!.push({ name: 'filter', in: 'query', schema: { type: 'array', items: { type: 'array', items: { type: 'string' } } } });
  } },
  { name: 'query serialization', hash: '9a117cbab072bfa80f2245b7eeeae6521e8349cf9c02b5d7c1b179c1aca46e67', expected: 'unsupported parameter serialization', mutate(spec: FixtureSpec) {
    operation(spec, LIST_PATH, 'get').parameters![1].explode = false;
  } },
  { name: 'success media', hash: 'c58c63c4f15231709fbbef577a8227466e5730089359496435561d9b22f835e7', expected: 'unsupported success media', mutate(spec: FixtureSpec) {
    operation(spec, CREATE_PATH, 'post').responses['200'].content = { 'audio/mpeg': { schema: { type: 'string' } } };
  } },
  { name: 'page pagination', hash: '1ca4f70df579058bf5a0181ce2e0f368411031b0aab5ce75df62f5cddb56b448', expected: 'unsupported pagination', mutate(spec: FixtureSpec) {
    operation(spec, LIST_PATH, 'get').parameters!.push({ name: 'page', in: 'query', schema: { type: 'integer' } });
  } },
  { name: 'skip pagination', hash: '7a1c7cb48030050f0f6fa5e15a2f831cc09d6f94e7d6ed998e1ba6da2ef2f856', expected: 'unsupported pagination', mutate(spec: FixtureSpec) {
    operation(spec, LIST_PATH, 'get').parameters!.push({ name: 'skip', in: 'query', schema: { type: 'integer' } });
  } },
  { name: 'nested pagination', hash: '08318f5a7f4c7250783d396a850ec4178106b9727ac472e476289155ea9f724e', expected: 'unsupported pagination', mutate(spec: FixtureSpec) {
    obj(schema(spec, 'Page').properties).pagination = { type: 'object', properties: { offset: { type: 'integer' } } };
  } },
  { name: 'missing next cursor', hash: '9e676a0ed104e60a17379351c467241a79287ec9bed482b9533ff8fecc1da408', expected: 'unsupported pagination', mutate(spec: FixtureSpec) {
    delete obj(schema(spec, 'Page').properties).next_cursor;
    schema(spec, 'Page').required = ['agents', 'has_more'];
  } },
  { name: 'unknown keyword', hash: '3c38edaf7161fb9bb147cdfcfabf1800c619e6488bd3f9428ad7de313782f912', expected: 'unknown schema keyword', mutate(spec: FixtureSpec) {
    schema(spec, 'CreateBody')['x-unreviewed-validation'] = true;
  } },
  { name: 'unknown nested keyword', hash: '06e0fb0e0823a2e426c77b8e35875c9e022e12c93520a99e545e6739f4e0b7ca', expected: 'unknown schema keyword', mutate(spec: FixtureSpec) {
    obj(obj(schema(spec, 'CreateBody').properties).name)['x-unreviewed-validation'] = true;
  } },
  { name: 'unevaluated request false', hash: '0920e5a7d4a3082fcfcfae8ac432ff7d8b4f918103e53124f30cddaab44b1777', expected: 'unsupported schema keyword unevaluatedProperties: create_agent_route/body; support requires a reviewed validator correction', mutate(spec: FixtureSpec) {
    operation(spec, CREATE_PATH, 'post').requestBody!.content['application/json'].schema = { type: 'object', unevaluatedProperties: false };
  } },
  { name: 'unevaluated response true', hash: 'b41a2a1080eeba6f18f1e12571d40bd778a5bc115e530d9dc4008f1341ce104b', expected: 'unsupported schema keyword unevaluatedProperties: create_agent_route/response/200/application/json; support requires a reviewed validator correction', mutate(spec: FixtureSpec) {
    operation(spec, CREATE_PATH, 'post').responses['200'].content = { 'application/json': { schema: { type: 'object', unevaluatedProperties: true } } };
  } },
  { name: 'unevaluated nested reference', hash: '56560ce87678a0e3fedc78ef79bc7bb920c2f542d47238d06a74e041ad098aa9', expected: 'unsupported schema keyword unevaluatedProperties: components/UnsupportedNested/properties/entry/allOf/0; support requires a reviewed validator correction', mutate(spec: FixtureSpec) {
    spec.components.schemas.UnsupportedNested = { type: 'object', properties: { entry: { allOf: [{ type: 'object', unevaluatedProperties: { type: 'integer' } }] } } };
    obj(schema(spec, 'CreateBody').properties).nested = { $ref: '#/components/schemas/UnsupportedNested' };
  } },
  { name: 'unknown format', hash: 'fd81339aa50334f1747893c4ab57f48b53caab09c70f49cdfa08b8537b5a92de', expected: 'unknown schema format', mutate(spec: FixtureSpec) {
    obj(obj(schema(spec, 'CreateBody').properties).name).format = 'unreviewed';
  } },
  { name: 'JSON binary', hash: '2ceeb05cd54b3df3e15cf49666a9cca203d70519cdf8b401a0144eb194549b79', expected: 'binary in JSON position', mutate(spec: FixtureSpec) {
    obj(schema(spec, 'CreateBody').properties).secret = { type: 'string', format: 'binary' };
  } },
  { name: 'binary behind reference', hash: '34f2efcaa302c010b7b9bc8e26c57f0db67095bd70e4f382d477e7027ec6ae03', expected: 'binary in JSON position', mutate(spec: FixtureSpec) {
    spec.components.schemas.HiddenBinary = { type: 'string', format: 'binary' };
    obj(schema(spec, 'CreateBody').properties).secret = { $ref: '#/components/schemas/HiddenBinary' };
  } },
  { name: 'response binary', hash: 'dbd9f63a1b4751fd0c458eb8f0f6544ec6d0ff294faf8a5a9c2b5d939e54ace4', expected: 'binary in JSON position', mutate(spec: FixtureSpec) {
    operation(spec, CREATE_PATH, 'post').responses['200'].content = { 'application/json': { schema: { type: 'string', format: 'binary' } } };
  } },
  { name: 'unbound binary', hash: '80a65950e985634b703bc185cfbb4a2d6e2b8e50b69759f807b7bb47e3b764cb', expected: 'unbound or mismatched binary field', mutate(spec: FixtureSpec) {
    obj(schema(spec, 'FileBody').properties).attachment = { type: 'string', format: 'binary' };
  } },
  { name: 'mismatched binary', hash: 'ebb5e07d2f3b25a87f357723dbaef845eda90b47795e059012d10dc434cbb0b2', expected: 'mismatched binary binding', mutate(spec: FixtureSpec) {
    obj(schema(spec, 'FileBody').properties).file = { type: 'string' };
  } },
  { name: 'missing binary', hash: 'cbd37a70b31e2311f1ccbca1f683da1fee17240aab4354f37de42250f03f237c', expected: 'unbound binary field', mutate(spec: FixtureSpec) {
    delete obj(schema(spec, 'FileBody').properties).file;
    schema(spec, 'FileBody').required = ['name'];
  } },
  { name: 'object multipart', hash: 'f920aad11c4c1f4a109e14aacc9ada1e301937b9069168f970ab5edeefc19a75', expected: 'non-scalar multipart', mutate(spec: FixtureSpec) {
    obj(schema(spec, 'FileBody').properties).name = { type: 'object', additionalProperties: true };
  } },
  { name: 'array multipart', hash: '80fc25db1cdb5383b165c8495bf4bd1d3f6231595e128b1993b1ee92fcd57bb8', expected: 'non-scalar multipart', mutate(spec: FixtureSpec) {
    obj(schema(spec, 'FileBody').properties).name = { type: 'array', items: { type: 'string' } };
  } },
  { name: 'duplicate IDs', hash: 'bcb61f19b26cd8fb0fef761f9893a7f218a7a95af39d069e71e9fa648722a731', expected: 'duplicate operation ID', mutate(spec: FixtureSpec) {
    operation(spec, CREATE_PATH, 'post').operationId = 'get_agents_route';
  } },
  { name: 'extra spec ID', hash: '769a4dfaa955869355bf35cb319c48e91fa9fed03d32c7f4161f6777a2455a60', expected: 'exact spec/policy operation ID set', mutate(spec: FixtureSpec) {
    spec.paths[LIST_PATH].post = { operationId: 'unreviewed_operation', responses: { '204': { description: 'Empty' } } };
  } },
  { name: 'missing spec ID', hash: '0a3f47aeb817767cb19abf6a614a6eb1ba7bf8e9eb7e9be018991b9db6b0baa3', expected: 'exact spec/policy operation ID set', mutate(spec: FixtureSpec) {
    delete spec.paths[FILE_PATH].post;
  } },
  { name: 'route mismatch', hash: '0f7c4b545cf6f9a52a152c08e3a82aba800482982bc8acc917d03f464eb35be3', expected: 'policy/spec route', mutate(spec: FixtureSpec) {
    spec.paths['/different'] = spec.paths[FILE_PATH]; delete spec.paths[FILE_PATH];
  } },
  { name: 'missing component', hash: '22fab9f6377bf98bf28ab7d14c9be64b4e56de919eecde128a7d4d7d75f0ab2b', expected: 'missing component', mutate(spec: FixtureSpec) {
    obj(schema(spec, 'CreateBody').properties).missing = { $ref: '#/components/schemas/Missing' };
  } },
  { name: 'external reference', hash: 'be749823f4d07b840384b366e3343c9627361077707ba6f51e5e30af6e0714f8', expected: 'unsupported schema reference', mutate(spec: FixtureSpec) {
    obj(schema(spec, 'CreateBody').properties).remote = { $ref: 'https://example.com/schema.json' };
  } },
];

function mutatedInput(testCase: typeof mutationCases[number]) {
  const spec = structuredClone(miniInput) as unknown as FixtureSpec;
  testCase.mutate(spec);
  const bytes = Buffer.from(JSON.stringify(spec, null, 2) + '\n');
  const source = { ...MINI_SOURCE, sha256: testCase.hash, bytes: bytes.length };
  return { spec, bytes, source };
}

function createValidator() {
  const ajv = new Ajv2020({
    strict: true, strictTypes: false, strictTuples: true, strictRequired: true,
    allowUnionTypes: false, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false,
  });
  addFormats(ajv, { mode: 'full', formats: ['date', 'date-time', 'uri'] });
  ajv.addFormat('zoneinfo', value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  });
  for (const keyword of SCHEMA_METADATA_KEYWORDS) ajv.addKeyword({ keyword, valid: true });
  return ajv;
}
const mini = compileMini();
const validCreateBody = {
  name: 'alpha', config: { active: true }, map: { primary: { name: 'one', children: [{ name: 'two' }] } },
  choice: null, intersection: { code: 'a', level: 1 }, union: { kind: 'a', value: 2 }, list: ['a'],
};
function miniBodyValidator() {
  return createValidator().compile({ ...descriptor(mini, 'create_agent_route').request.schema, $defs: mini.$defs });
}

// An independent schema-position walk used only for preservation assertions.
// Examples, defaults, enums and extension values remain opaque data.
function relocateProviderSchema(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  const node = obj(value);
  const output: Schema = {};
  for (const [key, child] of Object.entries(node)) {
    if (key === '$ref') output[key] = String(child).replace('#/components/schemas/', '#/$defs/');
    else if (['properties', 'patternProperties', '$defs', 'dependentSchemas'].includes(key)) output[key] = Object.fromEntries(Object.entries(obj(child)).map(([name, nested]) => [name, relocateProviderSchema(nested)]));
    else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) output[key] = (child as unknown[]).map(relocateProviderSchema);
    else if (['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'].includes(key)) output[key] = relocateProviderSchema(child);
    else if (key === 'discriminator') {
      const data = obj(child);
      output[key] = data.mapping ? { ...data, mapping: Object.fromEntries(Object.entries(obj(data.mapping)).map(([name, ref]) => [name, String(ref).replace('#/components/schemas/', '#/$defs/')])) } : data;
    } else output[key] = child;
  }
  return output;
}

describe('pinned operation policy and public artifacts', () => {
  it('has the immutable source pin and exact partition, milestone and prefix census', () => {
    const policy = validatePolicy(policyInput, rosters);
    expect(policy.source).toEqual({
      url: 'https://api.elevenlabs.io/openapi.json', retrieved_at: '2026-11-08T21:07:54.389549+00:00',
      sha256: '794bccdc06ac77a90e576807fac9d00204f5af6bba115a84bfd71ace208c11dc', bytes: 2675026, paths: 375, operations: 515,
    });
    const rows = Object.values(policy.operations);
    expect(rows).toHaveLength(515);
    for (const [status, count] of [['admitted', 40], ['planned', 366], ['excluded', 109]] as const) expect(rows.filter(row => row.status === status)).toHaveLength(count);
    for (const [milestone, count] of [[1, 40], [7, 134], [8, 35], [9, 131], [10, 66]] as const) expect(rows.filter(row => row.milestone === milestone)).toHaveLength(count);
    for (const [group, count] of [['account_and_keys', 9], ['identity_and_seats', 10], ['reception', 75], ['productions', 11], ['engineering', 4]] as const) {
      expect(rows.filter(row => row.exclusion_group === group)).toHaveLength(count);
      const prefixes = policy.exclusion_groups[group].prefixes;
      if (prefixes.length) expect(rows.filter(row => prefixes.some(prefix => matchesPrefix(row.path, prefix)))).toHaveLength(count);
    }
    expect(matchesPrefix('/v1/receptionist', '/v1/reception')).toBe(false);
    expect(matchesPrefix('/v1/reception', '/v1/reception')).toBe(true);
    expect(matchesPrefix('/v1/reception/items', '/v1/reception')).toBe(true);
    expect(matchesPrefix('/v1/convai/conversations', '/v1/convai/conversation')).toBe(false);
  });

  it('matches the independent 40-operation effects, methods and tools without adding registrations', () => {
    expect(Object.keys(effectExpectations)).toHaveLength(40);
    expect(apiCatalog.operations).toHaveLength(40);
    expect(apiCatalog.operations.map(row => row.operation_id)).toEqual(Object.keys(effectExpectations).sort());
    const counts: Record<string, number> = {};
    for (const row of apiCatalog.operations) {
      const expected = effectExpectations[row.operation_id as keyof typeof effectExpectations];
      expect({ profile: row.profile, effects: row.effects, method: row.method, tool: row.tool }, row.operation_id).toEqual(expected);
      expect(policyInput.operations[row.operation_id as keyof typeof policyInput.operations].effects).toEqual(expected.effects);
      const floors: Record<string, string> = { GET: 'read', DELETE: 'delete', PUT: 'change', PATCH: 'change' };
      if (floors[row.method]) expect(row.profile).toBe(floors[row.method]);
      counts[row.profile] = (counts[row.profile] ?? 0) + 1;
    }
    expect(counts).toEqual({ read: 17, create: 9, change: 6, delete: 4, tests: 3, query_knowledge: 1 });
    expect(apiCatalog.operations.filter(row => row.profile === 'query_knowledge').map(row => row.operation_id)).toEqual(['query_agent_knowledge_base_rag_route']);
    expect(apiCatalog.operations.some(row => ['elevenlabs_run_job', 'elevenlabs_place_call'].includes(row.tool))).toBe(false);
    expect(legacyTools).toHaveLength(32);
    expect(legacyTools.map(tool => tool.name)).toEqual([...legacyTools.map(tool => tool.name)].sort());
    for (const tool of legacyTools) {
      expect(tool.description).toBeTypeOf('string'); expect(tool.inputSchema).toBeDefined(); expect(tool.annotations).toBeDefined();
    }
    const cloneVoice = legacyTools.find(tool => tool.name === 'clone_voice');
    expect(cloneVoice).toHaveProperty('_meta');
  });

  it('validates coverage references against actual ordinary capture and separate-package registration/smoke roster', () => {
    expect(rosters['@mindstone/mcp-server-elevenlabs'].size).toBe(32);
    expect(rosters['@mindstone/mcp-server-elevenlabs-agents'].size).toBe(31);
    for (const [id, row] of Object.entries(policyInput.operations)) {
      expect(row.existing_coverage.reason, id).toBeTruthy();
      for (const ref of row.existing_coverage.tools) {
        const colon = ref.lastIndexOf(':');
        expect(rosters[ref.slice(0, colon)]?.has(ref.slice(colon + 1)), ref).toBe(true);
      }
      for (const ref of row.replacements) expect(policyInput.operations).toHaveProperty(ref);
    }
    expect(policyInput.operations.create_agent_route.existing_coverage.status).toBe('partial');
    expect(policyInput.operations.patch_agent_settings_route.existing_coverage.status).toBe('partial');
    expect(policyInput.operations.run_conversation_simulation_route.existing_coverage.status).toBe('partial');
    expect(policyInput.operations.post_conversation_feedback_route.existing_coverage.status).toBe('partial');
    expect(policyInput.operations.speech_to_speech_full.existing_coverage.reason).toContain('/v1/voice-changer/');
    expect(policyInput.operations.get_user_voices_v2.existing_coverage.reason).toContain('next_page_token');
    expect(policyInput.operations.usage_by_product_over_time.existing_coverage.tools).toEqual(['@mindstone/mcp-server-elevenlabs:get_usage_stats']);
    expect(policyInput.operations.usage_characters.existing_coverage.status).toBe('missing');
  });

  it('records the multi-step file/URL replacement and only admitted discovery follow-ups', () => {
    const legacyUpload = policyInput.operations.add_documentation_to_knowledge_base;
    expect(legacyUpload.status).toBe('excluded');
    expect(legacyUpload.replacements).toEqual(['create_file_document_route', 'create_url_document_route', 'get_agent_route', 'patch_agent_settings_route']);
    expect(legacyUpload.reason).toMatch(/file or URL/); expect(legacyUpload.reason).toMatch(/atomic/);
    for (const row of apiCatalog.operations) for (const ref of row.follow_ups) expect(apiCatalog.operations.some(op => op.operation_id === ref)).toBe(true);
  });

  it('rejects admitted follow-ups that are not read operations', () => {
    const followup = structuredClone(policyInput);
    followup.operations.create_agent_route.follow_ups = ['patch_agent_settings_route'];
    expect(() => validatePolicy(followup, rosters)).toThrow('follow_up must be a read operation');
  });

  it('keeps the exact own-property alias policy distinct from discovery aliases', () => {
    const overlay = apiCatalog.compatibility_overlay;
    expect(overlay.forbidden_aliases.map(rule => ({ ids: rule.operation_ids, path: rule.prompt_path, own: rule.own_properties }))).toEqual([
      { ids: ['create_agent_route', 'patch_agent_settings_route'], path: ['body', 'conversation_config', 'agent', 'prompt'], own: { llm_model: 'llm', knowledge_base_document_ids: 'knowledge_base' } },
      { ids: ['run_agent_test_suite_route'], path: ['body', 'agent_config_override', 'conversation_config', 'agent', 'prompt'], own: { llm_model: 'llm', knowledge_base_document_ids: 'knowledge_base' } },
    ]);
    expect(overlay.alias_behavior).toContain('no recursive scanning');
    expect(overlay.enum_snapshot_date).toBe('2026-11-08');
    expect(overlay.enum_error_advice).toContain('2026-11-08'); expect(overlay.enum_error_advice).toMatch(/Refresh.*catalogue/);
    expect(descriptor(apiCatalog, 'create_agent_route').search_aliases).toEqual(['agent']);
  });

  it('rejects unknown policy fields, route classifications, effects, refs and non-admitted follow-ups', () => {
    expect(() => policySchema.parse({ ...policyInput, unknown: true })).toThrow();
    const mutations: Array<(policy: typeof policyInput) => void> = [
      policy => { policy.operations.get_agents_route.effects.readOnlyHint = false; },
      policy => { policy.operations.get_agents_route.profile = 'create'; },
      policy => { policy.operations.get_agents_route.method = 'POST'; },
      policy => { policy.operations.create_agent_route.method = 'GET'; },
      policy => { policy.operations.update_tool_route.method = 'DELETE'; },
      policy => { policy.operations.delete_agent_route.method = 'PATCH'; },
      policy => { policy.operations.get_agents_route.method = 'PUT'; },
      policy => { policy.operations.get_agents_route.existing_coverage.tools = ['@mindstone/mcp-server-elevenlabs:invented']; },
      policy => { policy.operations.redirect_to_mintlify.replacements = ['invented']; },
      policy => { policy.operations.create_agent_route.follow_ups = ['get_agent_summaries_route']; },
      policy => { policy.operations.create_agent_route.follow_ups = ['invented']; },
      policy => { Object.assign(policy.operations.create_agent_route, { file_bindings: [{ field: 'file', kind: 'document' }] }); },
      policy => { policy.operations.create_file_document_route.timeout = 'standard'; },
      policy => { policy.operations.get_agent_summaries_route.milestone = 8; },
      policy => { policy.operations.redirect_to_mintlify.status = 'planned'; },
      policy => { policy.source.sha256 = '0'.repeat(64); },
    ];
    for (const mutate of mutations) {
      const policy = structuredClone(policyInput); mutate(policy);
      expect(() => validatePolicy(policy, rosters)).toThrow();
    }
    const followup = structuredClone(policyInput); followup.operations.create_agent_route.follow_ups = ['get_agent_summaries_route'];
    expect(() => validatePolicy(followup, rosters)).toThrow('follow_up must be admitted');
  });

  it('has deterministic committed outputs and an admitted-only reachable graph', async () => {
    expect(await readFile(resolve(root, 'src/generated/api-catalog.ts'), 'utf8')).toBe(renderCatalog(apiCatalog));
    expect(await readFile(resolve(root, 'API_COVERAGE.md'), 'utf8')).toBe(renderCoverage(policyInput, rosters));
    expect(Object.keys(apiCatalog.$defs)).toHaveLength(651);
    expect(apiCatalog.source).toEqual(policyInput.source);
    expect(apiCatalog.compatibility_overlay).toEqual(policyInput.compatibility_overlay);
    for (const descriptor of apiCatalog.operations) {
      const row = policyInput.operations[descriptor.operation_id as keyof typeof policyInput.operations];
      expect({ method: descriptor.method, path: descriptor.path, family: descriptor.family, milestone: descriptor.milestone, profile: descriptor.profile, effects: descriptor.effects, effect_reason: descriptor.effect_reason }).toEqual({ method: row.method, path: row.path, family: row.family, milestone: row.milestone, profile: row.profile, effects: row.effects, effect_reason: row.effect_reason });
      expect(descriptor.timeout).toBe(row.timeout ?? 'standard');
      expect(descriptor.search_aliases).toEqual(row.search_aliases ?? []);
      expect(descriptor.follow_ups).toEqual(row.follow_ups ?? []);
      expect(descriptor.rank).toBe(row.rank ?? 0);
      expect(descriptor.examples).toEqual(row.examples ?? []);
      expect((descriptor.request.files ?? []).map(({ field, kind }) => ({ field, kind }))).toEqual(row.file_bindings ?? []);
    }
    expect(apiCatalog.operations.map(row => row.operation_id)).toEqual([...apiCatalog.operations.map(row => row.operation_id)].sort());
    expect(apiCatalog).not.toHaveProperty('paths');
    expect(await readFile(resolve(root, 'API_COVERAGE.md'), 'utf8')).toContain('Public CI does **not** possess or validate the whole upstream snapshot');
    expect((await readFile(resolve(root, 'API_COVERAGE.md'), 'utf8')).split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| Operation'))).toHaveLength(515);
  });
});

describe('explicit pins and generation refusals', () => {
  it('hashes decompressed original bytes and treats JSON and gzip identically', () => {
    expect(createHash('sha256').update(miniBytes).digest('hex')).toBe(MINI_SOURCE.sha256);
    expect(verifySource(miniBytes, MINI_SOURCE)).toEqual(miniBytes);
    expect(verifySource(gzipSync(miniBytes), MINI_SOURCE)).toEqual(miniBytes);
    expect(originalBytes(gzipSync(miniBytes))).toEqual(miniBytes);
    expect(compileCatalog(gzipSync(miniBytes), miniPolicy(miniInput as unknown as FixtureSpec), MINI_SOURCE, rosters)).toEqual(mini);
    expect(() => compileCatalog(miniBytes, miniPolicy(miniInput as unknown as FixtureSpec), PINNED_SOURCE, rosters)).toThrow('source pin mismatch');
    expect(() => verifySource(Buffer.from(JSON.stringify(miniInput)), MINI_SOURCE)).toThrow('source pin mismatch');
    expect(() => verifySource(Buffer.concat([miniBytes, Buffer.from('\n')]), MINI_SOURCE)).toThrow('source pin mismatch');
    expect(() => validatePolicy({ ...miniPolicy(miniInput as unknown as FixtureSpec), source: { ...MINI_SOURCE, sha256: '0'.repeat(64) } }, rosters, MINI_SOURCE)).toThrow('policy source pin');
  });

  it('is deterministic under reordered policy objects', () => {
    const policy = miniPolicy(miniInput as unknown as FixtureSpec);
    policy.operations = Object.fromEntries(Object.entries(policy.operations).reverse());
    expect(renderCatalog(compileCatalog(miniBytes, policy, MINI_SOURCE, rosters))).toBe(renderCatalog(mini));
    expect(stableJson({ z: { b: 1, a: 2 }, a: [3, 1] })).toBe(stableJson({ a: [3, 1], z: { a: 2, b: 1 } }));
  });

  it.each(mutationCases)('refuses $name with a named construct', testCase => {
    const { bytes, source } = mutatedInput(testCase);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(testCase.hash);
    // Use the base policy for intentional ID-set/route defects.
    expect(() => compileCatalog(bytes, { ...miniPolicy(miniInput as unknown as FixtureSpec), source }, source, rosters)).toThrow(testCase.expected);
  });

  it('refuses absent or mismatched policy file bindings', () => {
    const jsonPolicy = miniPolicy(miniInput as unknown as FixtureSpec);
    jsonPolicy.operations.create_agent_route.file_bindings = [{ field: 'file', kind: 'document' }];
    expect(() => compileCatalog(miniBytes, jsonPolicy, MINI_SOURCE, rosters)).toThrow('mismatched binary binding');
    const policy = miniPolicy(miniInput as unknown as FixtureSpec);
    delete policy.operations.create_file_document_route.file_bindings;
    expect(() => compileCatalog(miniBytes, policy, MINI_SOURCE, rosters)).toThrow('unbound or mismatched binary field');
    policy.operations.create_file_document_route.file_bindings = [{ field: 'another', kind: 'document' }];
    expect(() => compileCatalog(miniBytes, policy, MINI_SOURCE, rosters)).toThrow('unbound or mismatched binary field');
    policy.operations.create_file_document_route.file_bindings = [{ field: 'file', kind: 'document' }, { field: 'file', kind: 'document' }];
    expect(() => compileCatalog(miniBytes, policy, MINI_SOURCE, rosters)).toThrow('duplicate binary binding');
  });
});

const compatibleCases = [
  { name: 'reference siblings', hash: '729296bc9b23987f9510bfb0e014f82b303c49a1412a5f62278153a40222233f', mutate(spec: FixtureSpec) {
    operation(spec, CREATE_PATH, 'post').responses['200'].content = { 'application/json': { schema: { $ref: '#/components/schemas/Node', type: 'object', minProperties: 2 } } };
  } },
  { name: 'plain and HTML success', hash: '4c9a38c3b90f82f6feaef65d43c7ec024bef869eea70d3c67326de5a3fdba2cd', mutate(spec: FixtureSpec) {
    operation(spec, CREATE_PATH, 'post').responses['200'].content = { 'text/plain': { schema: { type: 'string', minLength: 1 } }, 'text/html': { schema: { type: 'string', maxLength: 1000 } } };
  } },
];

describe('supported response constraints', () => {
  it.each(compatibleCases)('preserves $name with an explicit pin', testCase => {
    const spec = structuredClone(miniInput) as unknown as FixtureSpec; testCase.mutate(spec);
    const bytes = Buffer.from(JSON.stringify(spec, null, 2) + '\n');
    const source = { ...MINI_SOURCE, sha256: testCase.hash, bytes: bytes.length };
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(testCase.hash);
    const catalog = compileCatalog(bytes, { ...miniPolicy(miniInput as unknown as FixtureSpec), source }, source, rosters);
    const result = descriptor(catalog, 'create_agent_route');
    for (const response of result.responses) {
      const original = operation(spec, CREATE_PATH, 'post').responses[String(response.status)].content![response.media_type!].schema;
      expect(response.schema).toEqual(relocateProviderSchema(original));
    }
    if (testCase.name === 'reference siblings') {
      const validate = createValidator().compile({ ...result.responses[0].schema, $defs: catalog.$defs });
      expect(validate({ name: 'only-one' })).toBe(false); expect(validate({ name: 'two', extra: true })).toBe(true);
    } else expect(result.responses.map(response => response.media_type)).toEqual(['text/html', 'text/plain']);
  });
});

describe('provider graph semantics', () => {
  it('preserves unevaluatedProperties spelling in property names and opaque data with an explicit pin', () => {
    const spec = structuredClone(miniInput) as unknown as FixtureSpec;
    const body = schema(spec, 'CreateBody');
    obj(body.properties).unevaluatedProperties = { type: 'string' };
    body.example = { unevaluatedProperties: false };
    body.examples = [{ unevaluatedProperties: true }];
    body.default = { unevaluatedProperties: { type: 'integer' } };
    body.enum = [{ unevaluatedProperties: false }];
    const bytes = Buffer.from(JSON.stringify(spec, null, 2) + '\n');
    const source = { ...MINI_SOURCE, sha256: '8c3772f3fff7dcfdc9ac41fb0dc8c0a5c57949f4b2aff2e73afd949a03bfdf18', bytes: bytes.length };
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
    const before = structuredClone(spec);
    const result = compileCatalog(bytes, miniPolicy(spec, source), source, rosters);
    expect(result.$defs.CreateBody).toEqual(relocateProviderSchema(body));
    expect(result.$defs.CreateBody.properties.unevaluatedProperties).toEqual({ type: 'string' });
    for (const key of ['example', 'examples', 'default', 'enum']) expect(result.$defs.CreateBody[key]).toEqual(body[key]);
    expect(spec).toEqual(before);
  });

  it('preserves reachable source schemas, compositions and opaque data exactly', () => {
    expect(Object.keys(mini.$defs).sort()).toEqual(['Alpha', 'Beta', 'CreateBody', 'Node', 'Page']);
    for (const [name, value] of Object.entries(mini.$defs)) expect(value, name).toEqual(relocateProviderSchema(miniInput.components.schemas[name as keyof typeof miniInput.components.schemas]));
    expect(mini.$defs.CreateBody).not.toHaveProperty('additionalProperties');
    expect(mini.$defs.CreateBody.properties.config.additionalProperties).toBe(false);
    expect(mini.$defs.CreateBody.properties.open.additionalProperties).toBe(true);
    expect(mini.$defs.CreateBody.properties.map.additionalProperties).toEqual({ $ref: '#/$defs/Node' });
    expect(mini.$defs.CreateBody.properties.literal.default.$ref).toBe('#/components/schemas/NotASchemaReference');
    expect(mini.$defs.CreateBody.properties.literal.enum).toEqual(miniInput.components.schemas.CreateBody.properties.literal.enum);
    expect(mini.$defs.CreateBody.properties.keywordMap.properties.format).toEqual({ type: 'string' });
    expect(mini.$defs.CreateBody.properties.union.discriminator.mapping).toEqual({ a: '#/$defs/Alpha', b: '#/$defs/Beta' });
    expect(mini.$defs.Node.properties.children.items).toEqual({ $ref: '#/$defs/Node' });
    expect(mini.$defs).not.toHaveProperty('Unreachable');
    expect(mini.$defs).not.toHaveProperty('NotASchemaReference');
  });

  it('separates document operands and preserves scalar and file requiredness independently', () => {
    const create = descriptor(mini, 'create_file_document_route'); const update = descriptor(mini, 'update_file_document_route');
    expect(create.request.required).toBe(true); expect(create.request.schema.required).toEqual(['name']);
    expect(create.request.schema.properties).not.toHaveProperty('file');
    expect(create.request.schema).not.toHaveProperty('additionalProperties');
    expect(create.request.files).toEqual([{ field: 'file', kind: 'document', required: true, schema: miniInput.components.schemas.FileBody.properties.file }]);
    expect(create.timeout).toBe('long');
    expect(update.request.required).toBe(false); expect(update.request.files[0].required).toBe(false);
    expect(update.request.schema.required).toEqual(['name']); expect(update.request.schema.additionalProperties).toBe(false);
    expect(createValidator().compile({ ...create.request.schema, $defs: mini.$defs })({ name: 'guide', notify: false })).toBe(true);
    expect(createValidator().compile({ ...create.request.schema, $defs: mini.$defs })({})).toBe(false);
  });

  it('closes only synthesized path/query records and preserves scalar-array query constraints', () => {
    const list = descriptor(mini, 'get_agents_route');
    const query = createValidator().compile({ ...list.parameters.query, $defs: mini.$defs });
    expect(query({ cursor: 'next', page_size: 10, tags: ['a', 'b'] })).toBe(true);
    expect(query({ tags: ['c'] })).toBe(false); expect(query({ page_size: 101 })).toBe(false);
    expect(query({ unknown: true })).toBe(false);
    expect(list.parameters.query.additionalProperties).toBe(false); expect(list.parameters.path.additionalProperties).toBe(false);
    expect(list.pagination).toEqual({ request: 'cursor', response: 'next_cursor' });
    expect(list.parameters.query_serialization.tags).toBe('form-explode');
    expect(createValidator().compile({ ...descriptor(mini, 'update_file_document_route').parameters.path, $defs: mini.$defs })({ documentation_id: 'doc', extra: true })).toBe(false);
  });

  it('keeps required create fields, nested requirements, enums, maps, recursion and open objects', () => {
    const validate = miniBodyValidator();
    expect(validate(validCreateBody), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...validCreateBody, arbitrary: { dynamic_variable: true }, open: { unknown: { key: 'value' } } })).toBe(true);
    expect(validate({ ...validCreateBody, map: { primary: { name: 'one', arbitrary: 12 } } })).toBe(true);
    const invalidBodies = [
      {}, { ...validCreateBody, config: {} }, { ...validCreateBody, config: { active: true, extra: true } },
      { ...validCreateBody, name: 'gamma' }, { ...validCreateBody, map: { primary: { children: [] } } },
      { ...validCreateBody, choice: { name: 12 } }, { ...validCreateBody, intersection: { code: 'a' } },
      { ...validCreateBody, union: { kind: 'a', value: 'wrong' } }, { ...validCreateBody, list: [] },
      { ...validCreateBody, list: ['a', 'a'] }, { ...validCreateBody, falseSchema: 1 },
      { ...validCreateBody, keywordMap: { format: 12 } }, { ...validCreateBody, forbidden: 'bad' },
      { ...validCreateBody, map: { 'bad-key': { name: 'one' } } },
      { ...validCreateBody, condition: { kind: 'x' } },
    ];
    for (const body of invalidBodies) expect(validate(body), JSON.stringify(body)).toBe(false);
    expect(validate({ ...validCreateBody, nullable: null, choice: { name: 'ok' }, condition: { kind: 'x', x: 1 } })).toBe(true);
  });

  it('uses the reviewed validator options and metadata/format vocabulary without mutating input', () => {
    expect(VALIDATOR_OPTIONS).toEqual({ strict: true, strictTypes: false, strictTuples: true, strictRequired: true, allowUnionTypes: false, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
    expect(SCHEMA_FORMATS).toEqual(['date', 'date-time', 'uri', 'zoneinfo']);
    expect(SCHEMA_METADATA_KEYWORDS).toEqual(['example', 'discriminator', 'optional', 'name', 'embed', 'max_items', 'x-fern-enum', 'x-convai-client-override', 'x-fern-ignore', 'x-convai-soft-override-disallowed', 'x-convai-language-override', 'x-convai-runtime-override', 'x-convai-override-disallowed']);
    const validate = miniBodyValidator(); const body = { ...validCreateBody, arbitrary: 3 };
    const before = structuredClone(body); expect(validate(body)).toBe(true); expect(body).toEqual(before);
    expect(body).not.toHaveProperty('literal');
    expect(validate({ ...validCreateBody, config: { active: 'true' } })).toBe(false);
    expect(validate({ ...validCreateBody, formats: { date: '2026-11-08', 'date-time': '2026-11-08T21:07:54Z', uri: 'https://example.com', zoneinfo: 'Europe/Berlin' } })).toBe(true);
    for (const format of ['date', 'date-time', 'uri', 'zoneinfo']) expect(validate({ ...validCreateBody, formats: { [format]: 'invalid-value' } }), format).toBe(false);
  });
});

// Optional source-backed evidence is explicit. Public CI runs the consistency
// and miniature tests above, without possessing the whole upstream snapshot.
const sourcePath = process.env.ELEVENLABS_OPENAPI_SPEC;
describe('provided pinned full source', () => {
  it.skipIf(!sourcePath)('regenerates and checks both committed artifacts from JSON and gzip', async () => {
    const input = await readFile(sourcePath!); const bytes = verifySource(input, PINNED_SOURCE);
    expect(bytes).toHaveLength(2675026);
    const fromJson = compileCatalog(bytes, policyInput, PINNED_SOURCE, rosters);
    const fromGzip = compileCatalog(gzipSync(bytes), policyInput, PINNED_SOURCE, rosters);
    expect(fromJson).toEqual(apiCatalog); expect(fromGzip).toEqual(fromJson);
    expect(await generateArtifacts(root, sourcePath!, true)).toEqual({ operations: 40, components: 651, checked: true });
    const directory = await mkdtemp(join(tmpdir(), 'elevenlabs-pin-'));
    try {
      const file = join(directory, 'pinned.json'); await writeFile(file, bytes);
      expect(await generateArtifacts(root, file, true)).toEqual({ operations: 40, components: 651, checked: true });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.skipIf(!sourcePath)('preserves every retained provider component and each request/response schema directly', async () => {
    const bytes = verifySource(await readFile(sourcePath!), PINNED_SOURCE);
    const spec = JSON.parse(bytes.toString('utf8')) as FixtureSpec;
    expect(Object.keys(spec.paths)).toHaveLength(375);
    for (const [name, retained] of Object.entries(apiCatalog.$defs)) expect(retained, name).toEqual(relocateProviderSchema(spec.components.schemas[name]));
    for (const row of apiCatalog.operations) {
      const provider = operation(spec, row.path, row.method.toLowerCase());
      expect(provider.operationId).toBe(row.operation_id);
      for (const parameter of provider.parameters ?? []) {
        if (parameter.in === 'header') { expect(parameter.name).toBe('xi-api-key'); continue; }
        const record = parameter.in === 'path' ? row.parameters.path : row.parameters.query;
        expect(record.properties[parameter.name as keyof typeof record.properties]).toEqual(relocateProviderSchema(parameter.schema));
        expect(record.required.includes(parameter.name)).toBe(parameter.required === true);
      }
      if (provider.requestBody) {
        const original = provider.requestBody.content[row.request.media_type!].schema;
        if (row.request.media_type === 'application/json') expect(row.request.schema).toEqual(relocateProviderSchema(original));
        else {
          const multipart = structuredClone(obj(spec.components.schemas[String(original.$ref).split('/').at(-1)!]));
          const properties = obj(multipart.properties); const required = multipart.required as string[] | undefined;
          for (const file of row.request.files ?? []) {
            expect(file.field).toBe('file'); expect(file.kind).toBe('document');
            expect(file.required).toBe(required?.includes(file.field) ?? false);
            expect(file.schema).toEqual(properties[file.field]); delete properties[file.field];
          }
          if (required) multipart.required = required.filter(name => !row.request.files?.some(file => file.field === name));
          expect(row.request.schema).toEqual(relocateProviderSchema(multipart));
        }
        expect(row.request.required).toBe(provider.requestBody.required === true);
      } else expect(row.request.media_type).toBeNull();
      for (const response of row.responses) {
        if (response.media_type === null) continue;
        const original = provider.responses[String(response.status)].content?.[response.media_type]?.schema;
        if (original !== undefined) expect(response.schema).toEqual(relocateProviderSchema(original));
      }
    }
  });
});
