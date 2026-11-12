#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

export const PINNED_SOURCE = Object.freeze({
  url: 'https://api.elevenlabs.io/openapi.json',
  retrieved_at: '2026-11-08T21:07:54.389549+00:00',
  sha256: '794bccdc06ac77a90e576807fac9d00204f5af6bba115a84bfd71ace208c11dc',
  bytes: 2675026, paths: 375, operations: 515,
});

export const SCHEMA_METADATA_KEYWORDS = Object.freeze([
  'example', 'discriminator', 'optional', 'name', 'embed', 'max_items',
  'x-fern-enum', 'x-convai-client-override', 'x-fern-ignore',
  'x-convai-soft-override-disallowed', 'x-convai-language-override',
  'x-convai-runtime-override', 'x-convai-override-disallowed',
]);
export const SCHEMA_FORMATS = Object.freeze(['date', 'date-time', 'uri', 'zoneinfo']);
export const VALIDATOR_OPTIONS = Object.freeze({
  strict: true, strictTypes: false, strictTuples: true, strictRequired: true,
  allowUnionTypes: false, allErrors: true, coerceTypes: false,
  useDefaults: false, removeAdditional: false,
});

const idsByProfile = {
  read: 'get_agents_route get_agent_route list_available_llms get_tools_route get_tool_route get_tool_dependent_agents_route get_knowledge_base_list_route get_documentation_from_knowledge_base get_knowledge_base_content get_documentation_chunks_from_knowledge_base search_knowledge_base_content_route get_knowledge_base_dependent_agents get_rag_indexes get_agent_response_test_route list_chat_response_tests_route list_test_invocations_route get_test_invocation_route',
  create: 'create_agent_route duplicate_agent_route add_tool_route create_text_document_route create_url_document_route create_file_document_route create_folder_route rag_index_status create_agent_response_test_route',
  change: 'patch_agent_settings_route update_tool_route update_document_route update_file_document_route refresh_url_document_route update_agent_response_test_route',
  delete: 'delete_agent_route delete_tool_route delete_knowledge_base_document delete_chat_response_test_route',
  tests: 'run_agent_test_suite_route cancel_test_invocation_route resubmit_tests_route',
  query_knowledge: 'query_agent_knowledge_base_rag_route',
};
const profileTuples = {
  read: [true, false, true, true], create: [false, false, false, true],
  change: [false, true, false, true], delete: [false, true, false, true],
  tests: [false, true, false, true], query_knowledge: [true, false, false, true],
};
const annotationNames = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
export const PROFILE_EFFECTS = Object.fromEntries(Object.entries(profileTuples)
  .map(([profile, tuple]) => [profile, Object.fromEntries(annotationNames.map((key, i) => [key, tuple[i]]))]));
export const PROFILE_TOOLS = Object.freeze({
  read: 'elevenlabs_read_resource', create: 'elevenlabs_create_resource',
  change: 'elevenlabs_change_resource', delete: 'elevenlabs_delete_resource',
  tests: 'elevenlabs_run_agent_tests', query_knowledge: 'elevenlabs_query_knowledge',
});
const reviewedProfiles = Object.fromEntries(Object.entries(idsByProfile)
  .flatMap(([profile, ids]) => ids.split(' ').map(id => [id, profile])));

const exclusionGroups = {
  account_and_keys: { prefixes: ['/v1/service-accounts', '/v1/workspaces/api-keys'], count: 9 },
  identity_and_seats: { prefixes: ['/v1/workspace/groups', '/v1/workspace/invites', '/v1/workspace/members'], count: 10 },
  reception: { prefixes: ['/v1/reception'], count: 75 },
  productions: { prefixes: ['/v1/productions'], count: 11 },
  engineering: { prefixes: [], count: 4 },
};
const engineeringExclusions = {
  redirect_to_mintlify: [],
  run_conversation_simulation_route: ['create_agent_response_test_route', 'run_agent_test_suite_route', 'get_test_invocation_route'],
  run_conversation_simulation_route_stream: ['create_agent_response_test_route', 'run_agent_test_suite_route', 'get_test_invocation_route'],
  add_documentation_to_knowledge_base: ['create_file_document_route', 'create_url_document_route', 'get_agent_route', 'patch_agent_settings_route'],
};
export const FAMILY_COUNTS = Object.freeze({
  7: { agents: 38, agent: 2, 'agent-testing': 6, 'test-invocations': 1, 'knowledge-base': 14,
    tools: 1, conversations: 16, tags: 5, 'triage-tickets': 8, 'analysis-items': 9, analytics: 1,
    settings: 4, secrets: 6, 'environment-variables': 5, environments: 3, 'mcp-servers': 13, users: 1, 'llm-usage': 1 },
  8: { 'phone-numbers': 6, 'v2/phone-numbers': 1, 'batch-calling': 7, twilio: 2, exotel: 1,
    'sip-trunk': 1, whatsapp: 2, 'whatsapp-accounts': 4, conversation: 3, realtime: 8 },
  9: { 'text-to-speech': 4, 'text-to-dialogue': 4, 'sound-generation': 1, 'audio-effects': 1,
    'voice-changer': 2, 'audio-isolation': 4, 'speech-to-text': 3, 'forced-alignment': 1,
    music: 13, dubbing: 37, voices: 34, 'voices-v2': 1, 'shared-voices': 1, 'similar-voices': 1,
    'text-to-voice': 5, history: 5, 'pronunciation-dictionaries': 9, models: 1, usage: 1, user: 2, 'single-use-token': 1 },
  10: { studio: 23, 'audio-native': 4, 'speech-engine': 6, flows: 14, assets: 4,
    'workspace/analytics': 3, 'workspace/audit-logs': 1, 'workspace/auth-connections': 4,
    'workspace/resources': 3, 'workspace/webhooks': 4 },
});

const text = z.string().min(1);
const effectsSchema = z.object(Object.fromEntries(annotationNames.map(key => [key, z.boolean()]))).strict();
const sourceSchema = z.object({
  url: z.string().url(), retrieved_at: z.string().datetime({ offset: true }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(),
  paths: z.number().int().nonnegative(), operations: z.number().int().positive(),
}).strict();
const profileSchema = z.enum(['read', 'create', 'change', 'delete', 'tests', 'query_knowledge']);
const aliasSchema = z.object({
  operation_ids: z.array(text).nonempty(), prompt_path: z.array(text).nonempty(),
  own_properties: z.object({ llm_model: z.literal('llm'), knowledge_base_document_ids: z.literal('knowledge_base') }).strict(), reason: text,
}).strict();
const operationSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']),
  path: z.string().startsWith('/'), status: z.enum(['admitted', 'planned', 'excluded']),
  milestone: z.number().int().positive().nullable(), family: text,
  profile: profileSchema.nullable(), effects: effectsSchema.nullable(), effect_reason: text.nullable(),
  existing_coverage: z.object({
    status: z.enum(['covered', 'partial', 'missing', 'not-worth-exposing']),
    tools: z.array(text), reason: text, evidence: z.array(text),
  }).strict(),
  replacements: z.array(text), exclusion_group: text.optional(), reason: text.optional(),
  timeout: z.enum(['standard', 'long']).optional(),
  file_bindings: z.array(z.object({ field: text, kind: z.literal('document') }).strict()).optional(),
  search_aliases: z.array(text).optional(), rank: z.number().int().optional(),
  follow_ups: z.array(text).optional(), examples: z.array(z.record(z.unknown())).optional(),
}).strict();
export const policySchema = z.object({
  schema_version: z.literal(1), source: sourceSchema,
  compatibility_overlay: z.object({
    schema_constraints: text, enum_snapshot_date: z.literal('2026-11-08'), enum_error_advice: text,
    forbidden_aliases: z.array(aliasSchema), alias_behavior: text,
  }).strict(),
  exclusion_groups: z.record(z.object({ prefixes: z.array(text), count: z.number().int().nonnegative(), reason: text }).strict()),
  milestones: z.array(z.object({ number: z.number().int().positive(), version: z.null(), proposed_version: text.optional() }).strict()),
  local_discovery: z.object({ tool: z.literal('elevenlabs_discover_api'), effects: effectsSchema }).strict(),
  reserved_profiles: z.array(z.object({
    profile: z.enum(['run_job', 'place_call']), tool: text, milestone: z.number().int().positive(), effects: effectsSchema, reason: text,
  }).strict()),
  operations: z.record(operationSchema),
}).strict();

function refuse(construct, detail) {
  throw new Error(`${construct}: ${detail}`);
}
function requireEqual(actual, expected, construct) {
  if (!isDeepStrictEqual(actual, expected)) refuse(construct, `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
export function stableJson(value) {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}
export function originalBytes(input) {
  const bytes = Buffer.from(input);
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}
export function verifySource(input, expectedSource) {
  const expected = sourceSchema.parse(expectedSource);
  const bytes = originalBytes(input);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected.sha256 || bytes.length !== expected.bytes) {
    refuse('source pin mismatch', `expected ${expected.sha256} / ${expected.bytes} bytes, received ${sha256} / ${bytes.length}; provide the pinned input, never silently repin`);
  }
  return bytes;
}
export function matchesPrefix(path, prefix) {
  return path === prefix || path.startsWith(prefix + '/');
}
function classify(id, path) {
  if (Object.hasOwn(reviewedProfiles, id)) return { status: 'admitted', milestone: 1 };
  if (Object.hasOwn(engineeringExclusions, id)) return { status: 'excluded', milestone: null, exclusion_group: 'engineering' };
  for (const [group, { prefixes }] of Object.entries(exclusionGroups)) {
    if (prefixes.some(prefix => matchesPrefix(path, prefix))) return { status: 'excluded', milestone: null, exclusion_group: group };
  }
  for (const family of Object.keys(FAMILY_COUNTS[8])) {
    if (matchesPrefix(path, '/v1/convai/' + family)) return { status: 'planned', milestone: 8, family };
  }
  if (path.startsWith('/v1/convai/')) return { status: 'planned', milestone: 7, family: path.slice('/v1/convai/'.length).split('/')[0] };
  if (path === '/v2/voices') return { status: 'planned', milestone: 9, family: 'voices-v2' };
  for (const milestone of [9, 10]) {
    for (const family of Object.keys(FAMILY_COUNTS[milestone])) {
      if (matchesPrefix(path, '/v1/' + family)) return { status: 'planned', milestone, family };
    }
  }
  refuse('unclassified operation', `${id} ${path}`);
}

export function validatePolicy(raw, rosters, expectedSource = PINNED_SOURCE) {
  const policy = policySchema.parse(raw);
  requireEqual(policy.source, expectedSource, 'policy source pin');
  const entries = Object.entries(policy.operations);
  requireEqual(entries.length, expectedSource.operations, 'policy operation count');
  for (const [id, row] of entries) {
    if (!/^[a-zA-Z0-9_]+$/.test(id)) refuse('operation ID', id);
    const coverage = row.existing_coverage;
    const hasCoverage = ['covered', 'partial'].includes(coverage.status);
    if (hasCoverage !== (coverage.tools.length > 0) || (hasCoverage && coverage.evidence.length === 0)) refuse('coverage evidence', id);
    requireEqual(new Set(coverage.tools).size, coverage.tools.length, `duplicate coverage reference ${id}`);
    for (const ref of coverage.tools) {
      const colon = ref.lastIndexOf(':');
      const pkg = ref.slice(0, colon); const tool = ref.slice(colon + 1);
      if (colon < 0 || !rosters[pkg]?.has(tool)) refuse('unknown coverage tool', `${id}: ${ref}`);
    }
    for (const replacement of row.replacements) {
      if (!Object.hasOwn(policy.operations, replacement)) refuse('replacement reference', `${id}: ${replacement}`);
    }
    for (const followUp of row.follow_ups ?? []) {
      if (policy.operations[followUp]?.status !== 'admitted') refuse('follow_up must be admitted', `${id}: ${followUp}`);
    }
    if (row.status === 'admitted') {
      if (row.milestone !== 1 || row.profile === null || row.effects === null || row.effect_reason === null || row.exclusion_group !== undefined) refuse('admission metadata', id);
      const reviewedProfile = reviewedProfiles[id];
      if (!reviewedProfile || row.profile !== reviewedProfile) refuse('unreviewed effect assignment', id);
      requireEqual(row.effects, PROFILE_EFFECTS[reviewedProfile], `effect annotations ${id}`);
      const floor = { GET: 'read', DELETE: 'delete', PUT: 'change', PATCH: 'change' }[row.method];
      if (floor && floor !== row.profile) refuse('method effect floor', `${id}: ${row.method} requires ${floor}`);
      if (row.method !== 'POST' && floor === undefined) refuse('unsupported method', `${id}: ${row.method}`);
      if (row.method === 'POST' && row.profile === 'read') refuse('unreviewed POST read', id);
    } else {
      if (row.profile !== null || row.effects !== null || row.effect_reason !== null) refuse('non-admitted transport metadata', id);
      if (row.status === 'planned' && (![7, 8, 9, 10].includes(row.milestone) || row.exclusion_group !== undefined)) refuse('planned milestone', id);
      if (row.status === 'excluded' && (row.milestone !== null || !row.reason || !Object.hasOwn(policy.exclusion_groups, row.exclusion_group ?? ''))) refuse('exclusion metadata', id);
    }
  }
  const aliases = policy.compatibility_overlay.forbidden_aliases;
  const expectedAliases = [
    { ids: ['create_agent_route', 'patch_agent_settings_route'], path: ['body', 'conversation_config', 'agent', 'prompt'] },
    { ids: ['run_agent_test_suite_route'], path: ['body', 'agent_config_override', 'conversation_config', 'agent', 'prompt'] },
  ];
  requireEqual(aliases.map(rule => ({ ids: rule.operation_ids, path: rule.prompt_path })), expectedAliases, 'anchored alias overlay');
  requireEqual(policy.local_discovery.effects, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, 'local discovery effects');
  if (expectedSource.sha256 === PINNED_SOURCE.sha256) validateProductionCensus(policy);
  return policy;
}

function validateProductionCensus(policy) {
  const rows = Object.values(policy.operations);
  for (const [status, count] of Object.entries({ admitted: 40, planned: 366, excluded: 109 })) requireEqual(rows.filter(row => row.status === status).length, count, `census ${status}`);
  requireEqual(Object.keys(policy.exclusion_groups).sort(), Object.keys(exclusionGroups).sort(), 'exclusion groups');
  for (const [group, expected] of Object.entries(exclusionGroups)) {
    requireEqual(policy.exclusion_groups[group].prefixes, expected.prefixes, `exclusion prefixes ${group}`);
    requireEqual(policy.exclusion_groups[group].count, expected.count, `exclusion count ${group}`);
    requireEqual(rows.filter(row => row.exclusion_group === group).length, expected.count, `exclusion rows ${group}`);
  }
  requireEqual(Object.entries(policy.operations).filter(([, row]) => row.status === 'admitted').map(([id]) => id).sort(), Object.keys(reviewedProfiles).sort(), 'exact admitted IDs');
  for (const [id, row] of Object.entries(policy.operations)) {
    for (const [key, value] of Object.entries(classify(id, row.path))) requireEqual(row[key], value, `classification ${id}.${key}`);
    if (Object.hasOwn(engineeringExclusions, id)) requireEqual(row.replacements, engineeringExclusions[id], `replacement workflow ${id}`);
  }
  for (const [milestone, families] of Object.entries(FAMILY_COUNTS)) {
    const actual = {};
    for (const row of rows.filter(row => row.milestone === Number(milestone))) actual[row.family] = (actual[row.family] ?? 0) + 1;
    requireEqual(actual, families, `milestone ${milestone} family census`);
  }
  for (const id of ['create_file_document_route', 'update_file_document_route']) requireEqual(policy.operations[id].file_bindings, [{ field: 'file', kind: 'document' }], `document file binding ${id}`);
  for (const [id, row] of Object.entries(policy.operations)) {
    if (!['create_file_document_route', 'update_file_document_route'].includes(id) && row.file_bindings !== undefined) refuse('unreviewed file binding', id);
  }
  requireEqual(policy.operations.create_file_document_route.timeout, 'long', 'create-file long timeout');
  requireEqual(policy.milestones, [{ number: 1, proposed_version: '0.6.0', version: null }, ...[7, 8, 9, 10].map(number => ({ number, version: null }))], 'unpublished milestones');
  requireEqual(policy.reserved_profiles.map(row => ({ profile: row.profile, tool: row.tool, milestone: row.milestone, effects: row.effects })), [
    { profile: 'run_job', tool: 'elevenlabs_run_job', milestone: 9, effects: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    { profile: 'place_call', tool: 'elevenlabs_place_call', milestone: 8, effects: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  ], 'unregistered reserved profiles');
}

export async function loadCoverageRosters(connectorRoot) {
  const ordinary = JSON.parse(await readFile(resolve(connectorRoot, 'test/fixtures/legacy-tools.json'), 'utf8'));
  const names = ordinary.map(tool => text.parse(tool.name));
  requireEqual(names.length, 32, 'captured legacy tool count');
  requireEqual(new Set(names).size, 32, 'unique captured legacy tools');
  if (ordinary.some(tool => !tool.description || !tool.inputSchema || !tool.annotations)) refuse('incomplete legacy capture', 'expected complete SDK definitions');
  const agentsRoot = resolve(connectorRoot, '../elevenlabs-agents');
  const smoke = await readFile(resolve(agentsRoot, 'test/smoke.test.ts'), 'utf8');
  const rosterText = smoke.match(/const EXPECTED_TOOL_NAMES = \[([\s\S]*?)\]\.sort\(\)/)?.[1];
  if (!rosterText) refuse('separate-package roster', 'missing smoke roster');
  const agents = [...rosterText.matchAll(/'([a-z_]+)'/g)].map(match => match[1]).sort();
  const registrations = [];
  for (const file of (await readdir(resolve(agentsRoot, 'src/tools'))).filter(file => file.endsWith('.ts')).sort()) {
    const source = await readFile(resolve(agentsRoot, 'src/tools', file), 'utf8');
    registrations.push(...[...source.matchAll(/server\.registerTool\(\s*'([a-z_]+)'/g)].map(match => match[1]));
  }
  requireEqual(agents.length, 31, 'separate-package smoke count');
  requireEqual(registrations.sort(), agents, 'separate-package actual registration roster');
  return { '@mindstone/mcp-server-elevenlabs': new Set(names), '@mindstone/mcp-server-elevenlabs-agents': new Set(agents) };
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
function collectOperations(spec) {
  if (spec.openapi !== '3.1.0') refuse('OpenAPI dialect', String(spec.openapi));
  const operations = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation.operationId) refuse('missing operation ID', `${method} ${path}`);
      if (operations.has(operation.operationId)) refuse('duplicate operation ID', operation.operationId);
      operations.set(operation.operationId, { method: method.toUpperCase(), path, operation, pathParameters: item.parameters ?? [] });
    }
  }
  return operations;
}

// Only schema-bearing positions recurse. A property named "format", or a $ref
// inside an example/default/enum value, is data and must survive unchanged.
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaSingles = new Set(['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']);
const standardKeywords = new Set([
  '$ref', '$schema', '$id', '$anchor', '$comment', 'type', 'title', 'description', 'default', 'examples', 'enum', 'const',
  'required', 'dependentRequired', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'minContains', 'maxContains',
  'minProperties', 'maxProperties', 'readOnly', 'writeOnly', 'deprecated', 'nullable', 'contentEncoding', 'contentMediaType',
  ...schemaMaps, ...schemaArrays, ...schemaSingles, ...SCHEMA_METADATA_KEYWORDS,
]);
function componentName(ref) {
  if (typeof ref !== 'string' || !/^#\/components\/schemas\/[^/]+$/.test(ref)) refuse('unsupported schema reference', String(ref));
  return ref.slice('#/components/schemas/'.length);
}
function componentSchema(spec, name) {
  const schemas = spec.components?.schemas;
  if (!schemas || !Object.hasOwn(schemas, name) || schemas[name] === undefined) refuse('missing component', name);
  return schemas[name];
}
function resolveSchema(schema, spec, visited = new Set()) {
  if (typeof schema !== 'object' || schema === null || !schema.$ref) return schema;
  const name = componentName(schema.$ref);
  if (visited.has(name)) refuse('cyclic root schema', name);
  visited.add(name);
  const target = componentSchema(spec, name);
  const { $ref, ...siblings } = schema;
  if (Object.keys(siblings).some(key => !['description', 'title', ...SCHEMA_METADATA_KEYWORDS].includes(key))) refuse('constrained root reference', name);
  return { ...resolveSchema(target, spec, visited), ...siblings };
}
function scalarShape(schema, spec, allowArray, visited = new Set()) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (schema.$ref) {
    const name = componentName(schema.$ref);
    if (visited.has(name)) return false;
    const next = new Set(visited); next.add(name);
    const { $ref, ...siblings } = schema;
    return scalarShape(componentSchema(spec, name), spec, allowArray, next)
      && (!Object.keys(siblings).some(key => ['type', 'anyOf', 'oneOf', 'allOf', 'items', 'properties'].includes(key)) || scalarShape(siblings, spec, allowArray, next));
  }
  if (schema.format === 'binary') return false;
  const compositions = ['anyOf', 'oneOf', 'allOf'].filter(key => schema[key]);
  if (compositions.length) return compositions.every(key => schema[key].every(child => scalarShape(child, spec, allowArray, new Set(visited))));
  if (schema.type === 'array') return allowArray && scalarShape(schema.items, spec, false, visited);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.every(type => ['string', 'number', 'integer', 'boolean', 'null'].includes(type));
}

function schemaCompiler(spec) {
  const defs = Object.create(null);
  function transform(schema, location, binary = false) {
    if (typeof schema === 'boolean') return schema;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) refuse('invalid schema', location);
    if (Object.hasOwn(schema, 'unevaluatedProperties')) refuse('unsupported schema keyword unevaluatedProperties', `${location}; support requires a reviewed validator correction`);
    const output = {};
    for (const [key, value] of Object.entries(schema)) {
      if (!standardKeywords.has(key)) refuse('unknown schema keyword', `${location}: ${key}`);
      if (key === '$ref') {
        const name = componentName(value);
        if (!Object.hasOwn(defs, name)) {
          const component = componentSchema(spec, name);
          defs[name] = true;
          defs[name] = transform(component, `components/${name}`);
        }
        output[key] = '#/$defs/' + name;
      } else if (key === 'format') {
        if (value === 'binary' ? !binary || schema.type !== 'string' : !SCHEMA_FORMATS.includes(value)) refuse(value === 'binary' ? 'binary in JSON position' : 'unknown schema format', `${location}: ${value}`);
        output[key] = value;
      } else if (schemaMaps.has(key)) {
        output[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, transform(child, `${location}/${key}/${name}`)]));
      } else if (schemaArrays.has(key)) {
        if (!Array.isArray(value)) refuse('invalid schema composition', `${location}/${key}`);
        output[key] = value.map((child, i) => transform(child, `${location}/${key}/${i}`));
      } else if (schemaSingles.has(key)) {
        output[key] = transform(value, `${location}/${key}`);
      } else if (key === 'discriminator' && value?.mapping) {
        output[key] = { ...value, mapping: Object.fromEntries(Object.entries(value.mapping).map(([name, ref]) => {
          const relocated = transform({ $ref: ref }, `${location}/discriminator/${name}`).$ref;
          return [name, relocated];
        })) };
      } else {
        output[key] = structuredClone(value);
      }
    }
    return output;
  }
  return { defs, transform };
}

function parameterRecords(parameters, spec, transform, id) {
  const records = { path: { type: 'object', properties: Object.create(null), required: [], additionalProperties: false }, query: { type: 'object', properties: Object.create(null), required: [], additionalProperties: false } };
  const serialization = Object.create(null);
  for (const parameter of parameters) {
    if (parameter.$ref) refuse('parameter reference', id);
    const { name, schema, required = false } = parameter;
    if (parameter.in === 'header' && name === 'xi-api-key') {
      transform(schema, `${id}/injected-header/${name}`);
      continue;
    }
    if (parameter.in === 'header') refuse('unsupported header parameter', `${id}: ${name}`);
    if (!['path', 'query'].includes(parameter.in)) refuse('unsupported parameter location', `${id}: ${parameter.in} ${name}`);
    if (!scalarShape(schema, spec, parameter.in === 'query')) refuse(parameter.in === 'query' ? 'non-scalar query' : 'non-scalar path', `${id}: ${name}`);
    if (parameter.content || parameter.allowReserved || (parameter.style && parameter.style !== (parameter.in === 'query' ? 'form' : 'simple')) || (parameter.in === 'query' && parameter.explode === false)) refuse('unsupported parameter serialization', `${id}: ${name}`);
    const record = records[parameter.in];
    if (Object.hasOwn(record.properties, name)) refuse('duplicate parameter', `${id}: ${parameter.in}.${name}`);
    if (parameter.in === 'path' && !required) refuse('optional path parameter', `${id}: ${name}`);
    record.properties[name] = transform(schema, `${id}/${parameter.in}/${name}`);
    if (required) record.required.push(name);
    if (parameter.in === 'query') serialization[name] = 'form-explode';
  }
  for (const record of Object.values(records)) record.required.sort();
  return { ...records, query_serialization: serialization };
}

function requestDescriptor(operation, row, spec, transform, id) {
  const body = operation.requestBody;
  if (!body) {
    if (row.file_bindings?.length) refuse('unbound binary field', id);
    return { media_type: null, required: false };
  }
  if (body.$ref) refuse('request body reference', id);
  const content = Object.entries(body.content ?? {});
  if (content.length !== 1) refuse('unsupported request media', `${id}: expected one JSON or multipart representation`);
  const [media, data] = content[0];
  if (media === 'application/json') {
    if (row.file_bindings?.length) refuse('mismatched binary binding', id);
    return { media_type: media, required: body.required === true, schema: transform(data.schema, `${id}/body`) };
  }
  if (media !== 'multipart/form-data') refuse('unsupported request media', `${id}: ${media}`);
  if (data.encoding) refuse('multipart encoding', id);
  const root = resolveSchema(data.schema, spec);
  if (root?.type !== 'object' || !root.properties || ['anyOf', 'oneOf', 'allOf', 'patternProperties', 'dependentSchemas', 'dependentRequired', 'if', 'then', 'else', 'not'].some(key => key in root)) refuse('non-scalar multipart', `${id}: expected an object of scalar fields and explicitly bound binary operands`);
  const scalar = structuredClone(root);
  const bindings = new Map((row.file_bindings ?? []).map(binding => [binding.field, binding]));
  if (bindings.size !== (row.file_bindings ?? []).length) refuse('duplicate binary binding', id);
  const files = [];
  for (const [field, schema] of Object.entries(root.properties)) {
    const resolved = resolveSchema(schema, spec);
    if (resolved?.format === 'binary') {
      const binding = bindings.get(field);
      if (!binding || resolved.type !== 'string') refuse('unbound or mismatched binary field', `${id}: ${field}`);
      files.push({ ...binding, required: (root.required ?? []).includes(field), schema: transform(resolved, `${id}/file/${field}`, true) });
      bindings.delete(field);
      delete scalar.properties[field];
      if (scalar.required) scalar.required = scalar.required.filter(name => name !== field);
    } else {
      if (bindings.has(field)) refuse('mismatched binary binding', `${id}: ${field}`);
      if (!scalarShape(schema, spec, false)) refuse('non-scalar multipart', `${id}: ${field}`);
    }
  }
  if (bindings.size) refuse('unbound binary field', `${id}: ${[...bindings.keys()].join(', ')}`);
  return { media_type: media, required: body.required === true, schema: transform(scalar, `${id}/multipart-fields`), files: files.sort((a, b) => a.field < b.field ? -1 : 1) };
}

function successDescriptors(operation, transform, id) {
  const responses = [];
  for (const [status, response] of Object.entries(operation.responses ?? {}).sort()) {
    if (!/^2[0-9][0-9]$/.test(status)) continue;
    if (response.$ref) refuse('response reference', id);
    const content = Object.entries(response.content ?? {});
    if (content.length === 0) responses.push({ status: Number(status), media_type: null });
    for (const [media, data] of content.sort()) {
      if (!['application/json', 'text/plain', 'text/html'].includes(media)) refuse('unsupported success media', `${id}: ${media}`);
      responses.push({ status: Number(status), media_type: media, ...(data.schema === undefined ? {} : { schema: transform(data.schema, `${id}/response/${status}/${media}`) }) });
    }
  }
  if (responses.length === 0) refuse('missing concrete success response', id);
  return responses;
}
function paginationDescriptor(operation, parameters, responses, spec, id) {
  const queries = parameters.filter(parameter => parameter.in === 'query').map(parameter => parameter.name);
  function rootProperties(schema, seen = new Set()) {
    if (schema === null || typeof schema !== 'object') return [];
    const names = Object.keys(schema.properties ?? {});
    if (schema.$ref) {
      const name = componentName(schema.$ref);
      if (!seen.has(name)) {
        const next = new Set(seen); next.add(name);
        names.push(...rootProperties(componentSchema(spec, name), next));
      }
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      for (const branch of schema[keyword] ?? []) names.push(...rootProperties(branch, new Set(seen)));
    }
    return names;
  }
  const properties = responses.flatMap(response => {
    const schema = operation.responses[String(response.status)]?.content?.[response.media_type]?.schema;
    return rootProperties(schema);
  });
  const unsupported = new Set(['offset', 'skip', 'limit', 'page', 'page_number', 'page_index', 'page_token', 'page_key', 'page_cursor',
    'next_page_token', 'start_after', 'start_after_history_item_id', 'last_doc', 'next_page', 'next_token',
    'after', 'before', 'starting_after', 'ending_before', 'continuation', 'continuation_token', 'continuationToken', 'pagination', 'paging']);
  if ([...queries, ...properties].some(name => unsupported.has(name))) refuse('unsupported pagination', `${id}: only cursor -> next_cursor is supported`);
  if (queries.includes('cursor') !== properties.includes('next_cursor')) refuse('unsupported pagination', `${id}: expected cursor -> next_cursor pair`);
  return queries.includes('cursor') ? { request: 'cursor', response: 'next_cursor' } : null;
}

// Every caller supplies its own explicit pin. The CLI always uses PINNED_SOURCE;
// miniature fixtures never weaken or replace that production pin.
export function compileCatalog(input, rawPolicy, expectedSource, rosters) {
  const bytes = verifySource(input, expectedSource);
  const policy = validatePolicy(rawPolicy, rosters, expectedSource);
  const spec = JSON.parse(bytes.toString('utf8'));
  requireEqual(Object.keys(spec.paths ?? {}).length, expectedSource.paths, 'source path count');
  const operations = collectOperations(spec);
  requireEqual([...operations.keys()].sort(), Object.keys(policy.operations).sort(), 'exact spec/policy operation ID set');
  for (const [id, { method, path }] of operations) {
    requireEqual({ method: policy.operations[id].method, path: policy.operations[id].path }, { method, path }, `policy/spec route ${id}`);
  }
  const { defs, transform } = schemaCompiler(spec);
  const descriptors = [];
  for (const [id, row] of Object.entries(policy.operations).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (row.status !== 'admitted') continue;
    const { operation, pathParameters } = operations.get(id);
    const parameters = [...pathParameters, ...(operation.parameters ?? [])];
    const records = parameterRecords(parameters, spec, transform, id);
    const placeholders = [...row.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
    requireEqual(Object.keys(records.path.properties).sort(), placeholders, `path operand bindings ${id}`);
    const request = requestDescriptor(operation, row, spec, transform, id);
    const responses = successDescriptors(operation, transform, id);
    descriptors.push({
      operation_id: id, method: row.method, path: row.path, family: row.family, milestone: row.milestone,
      profile: row.profile, tool: PROFILE_TOOLS[row.profile], effects: row.effects, effect_reason: row.effect_reason,
      summary: operation.summary ?? id, description: operation.description ?? '', deprecated: operation.deprecated === true,
      parameters: records, request, responses,
      pagination: paginationDescriptor(operation, parameters, responses, spec, id),
      timeout: row.timeout ?? 'standard', authentication: { header: 'xi-api-key', supplied_by: 'connector' },
      search_aliases: row.search_aliases ?? [], rank: row.rank ?? 0, follow_ups: row.follow_ups ?? [], examples: row.examples ?? [],
    });
  }
  return sortKeys({ source: policy.source, compatibility_overlay: policy.compatibility_overlay,
    schema_metadata_keywords: SCHEMA_METADATA_KEYWORDS, schema_formats: SCHEMA_FORMATS,
    validator_options: VALIDATOR_OPTIONS, operations: descriptors, $defs: defs });
}

export function renderCatalog(catalog) {
  // JSON parsing preserves own __proto__ keys that object literals turn into prototypes.
  return '// Generated by scripts/generate-api-catalog.mjs; do not edit.\n'
    + '// Only admitted operations and their reachable provider schemas are included.\n'
    + 'export const apiCatalog: unknown = JSON.parse(' + JSON.stringify(stableJson(catalog).trimEnd()) + ');\n';
}
function cell(value) { return String(value).replaceAll('|', '\\|').replaceAll('\n', ' '); }
export function renderCoverage(rawPolicy, rosters) {
  const policy = validatePolicy(rawPolicy, rosters);
  const rows = Object.entries(policy.operations).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const counts = Object.fromEntries(['admitted', 'planned', 'excluded'].map(status => [status, rows.filter(([, row]) => row.status === status).length]));
  const lines = [
    '# ElevenLabs API coverage', '',
    'Generated from the explicit operation policy. Admission describes the new API interface; existing coverage is an independent assessment of the unchanged ordinary and Agents packages.', '',
    `Source: ${policy.source.url}`, `Retrieved: ${policy.source.retrieved_at}`, `SHA-256 (original decompressed bytes): \`${policy.source.sha256}\``,
    `Source census: ${policy.source.paths} paths; ${policy.source.operations} HTTP operation IDs; ${policy.source.bytes.toLocaleString('en-US')} bytes.`, '',
    `Partition: **${counts.admitted} admitted + ${counts.planned} planned + ${counts.excluded} excluded = ${rows.length}**.`, '',
    'Numeric milestones: 1 (40), 7 (134), 8 (35), 9 (131), 10 (66). Version 0.6.0 is proposed for the first interface only; no release is authorized and later versions are unset.', '',
    'Only admitted descriptors and their reachable component graph enter the generated catalogue. Seven registered API tools expose local discovery and six execution profiles for the 40 admitted operations, alongside the unchanged ordinary 32 definitions (39 total). The separate Agents package is unchanged. Reserved run_job and place_call tools are unregistered.', '',
    'Public consistency tests validate the committed policy, catalogue, ledger and explicitly pinned miniature fixtures. Public CI does **not** possess or validate the whole upstream snapshot. Full-source generation and --check require an explicit local JSON or gzip input matching the pinned original bytes; the whole source is neither committed nor included in npm. No runtime fetch occurs.', '',
    'Regenerate from the connector directory: `npm run api:generate -- --spec <pinned.json-or-gzip>`. Verify with `npm run api:check -- --spec <pinned.json-or-gzip>`. Both commands verify the immutable production source pin.', '',
    'Provider constraints (including enums, required fields, maps and open objects) are preserved. Only synthesized path/query records are closed. Forbidden aliases are exact anchored own-property checks described in the compatibility overlay, separate from discovery search aliases. Enum errors refer to the 2026-11-08 snapshot and recommend a reviewed catalogue refresh.', '',
    'Document uploads bind only multipart field `file` as a document. File requiredness is separate from scalar multipart fields; create-file uses the existing long request timeout category. Document uploads use document MIME types with application/octet-stream fallback, regular-file and descriptor identity checks, and the runtime buffer size limit. Provider format and account limits still apply. The legacy audio MIME fallback is unchanged.', '',
    'Saved Tests can spend credits and invoke real integrations. No implicit mocks, retries, polling, attachment merges or cleanup are authorized. Knowledge retrieval can spend credits but creates no conversation. Host permission bands determine authority; these annotations are not a host rating.', '',
    'Ajv and ajv-formats are direct dependencies so the validator interprets the retained schema graph directly with strict, non-mutating validation and full standard formats; zoneinfo uses Intl. They are existing locked dependencies promoted to direct dependencies, not a claim that Zod cannot represent unions or recursion.', '',
    '## Exclusions', '',
    ...Object.entries(policy.exclusion_groups).sort().map(([name, group]) => `- ${name}: ${group.count}. ${group.reason}`), '',
    'Deprecated upload replacement: create a file **or URL** document, preserving optional name; optional attachment requires get_agent_route followed by an explicit caller-authored patch_agent_settings_route with existing structured locators plus the new locator. The document response model is the same; inputs and atomic behavior differ. No automatic read/merge/write or cleanup is implied.', '',
    '## Exact operation ledger', '',
    '| Operation ID | Method | Path | Status | Milestone | Family | Profile | Existing coverage | Existing package:tool references | Reason / replacements |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const [id, row] of rows) {
    const reason = [...new Set([row.reason, row.existing_coverage.reason, row.replacements.length ? 'Replacement IDs: ' + row.replacements.join(', ') : ''].filter(Boolean))].join(' ');
    lines.push('| ' + [id, row.method, row.path, row.status, row.milestone ?? '—', row.family, row.profile ?? '—', row.existing_coverage.status, row.existing_coverage.tools.join(', ') || '—', reason].map(cell).join(' | ') + ' |');
  }
  return lines.join('\n') + '\n';
}

export async function generateArtifacts(connectorRoot, specPath, check = false) {
  const policy = JSON.parse(await readFile(resolve(connectorRoot, 'api/operation-policy.json'), 'utf8'));
  const rosters = await loadCoverageRosters(connectorRoot);
  const catalog = compileCatalog(await readFile(specPath), policy, PINNED_SOURCE, rosters);
  const outputs = new Map([
    ['src/generated/api-catalog.ts', renderCatalog(catalog)],
    ['API_COVERAGE.md', renderCoverage(policy, rosters)],
  ]);
  for (const [relativePath, content] of outputs) {
    const path = resolve(connectorRoot, relativePath);
    if (check) {
      const existing = await readFile(path, 'utf8');
      if (existing !== content) refuse('generated artifact drift', relativePath);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }
  return { operations: catalog.operations.length, components: Object.keys(catalog.$defs).length, checked: check };
}
async function main(args) {
  let specPath; let check = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--spec' && args[index + 1] && !specPath) specPath = args[++index];
    else if (args[index] === '--check' && !check) check = true;
    else refuse('CLI arguments', 'Usage: node scripts/generate-api-catalog.mjs --spec <JSON-or-gzip> [--check]');
  }
  if (!specPath) refuse('missing pinned input', 'Pass --spec <JSON-or-gzip>; this generator never fetches upstream');
  const connectorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(await generateArtifacts(connectorRoot, resolve(specPath), check)));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
