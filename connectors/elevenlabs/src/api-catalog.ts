import { createRedactor } from './api-sensitive.js';
import { z } from 'zod';
import { apiFamilies, discoveryFamilies } from './generated/api-metadata.js';
import { ElevenLabsError } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';
import { binaryFileShape, multipartFieldEncoding } from './api-multipart-shapes.mjs';
import { base64AudioSchema, multipartResponseSchema, audioRepresentation, binaryExtensions, isBinaryMedia } from './api-media.mjs';

export type JsonSchema = boolean | Record<string, unknown>;
export const profileSchema = z.enum(['read', 'create', 'change', 'delete', 'tests', 'query_knowledge', 'run_job', 'place_call']);
export type ApiProfile = z.infer<typeof profileSchema>;
export const API_TOOLS = {
  discover: 'elevenlabs_discover_api', read: 'elevenlabs_read_resource',
  create: 'elevenlabs_create_resource', change: 'elevenlabs_change_resource',
  delete: 'elevenlabs_delete_resource', tests: 'elevenlabs_run_agent_tests',
  query_knowledge: 'elevenlabs_query_knowledge', run_job: 'elevenlabs_run_job',
  place_call: 'elevenlabs_place_call',
} as const;

const reviewedGetCreates = ['get_conversation_signed_link', 'get_signed_url_deprecated', 'get_livekit_token'];
const credentialIssuers = [...reviewedGetCreates, 'create_realtime_session', 'register_twilio_call', 'get_single_use_token'];
const realtimeAuthorizationPath = ['session', 'tools', '*', 'authorization'];

export interface ValidationIssue { path: string[]; keyword: string; message: string }
export function inputIssues(issues: z.ZodIssue[], allowedFields: (path: string[]) => string[]): ValidationIssue[] {
  return issues.flatMap((issue): ValidationIssue[] => {
    const trusted = issue.code === 'custom' && issue.params?.keyword;
    const path: string[] = [];
    for (const part of issue.path.map(String)) {
      if (!trusted && !allowedFields(path).includes(part) && typeof issue.path[path.length] !== 'number') { path.push('[REDACTED]'); break; }
      path.push(part);
    }
    if (issue.code === 'unrecognized_keys') return [{
      path: [...path, '[REDACTED]'], keyword: issue.code, message: `An undeclared field is present. Allowed fields here: ${allowedFields(path).join(', ')}.`,
    }];
    const message = issue.code === 'invalid_type' ? `Expected ${issue.expected}.`
      : issue.code === 'invalid_enum_value' ? `Allowed values: ${issue.options.join(', ')}.`
      : issue.code === 'custom' && !trusted ? 'The field value [REDACTED] does not satisfy the declared contract.' : issue.message;
    return [{ path, keyword: trusted ? String(trusted) : issue.code, message }];
  });
}
/** Preserve the published schema, but give SDK validation only connector-owned diagnostics. */
export function privateInputSchema<S extends z.AnyZodObject>(schema: S, fields: (path: string[]) => string[]) {
  const guarded = schema.extend({});
  guarded.safeParseAsync = async (value, params) => {
    const parsed = await schema.safeParseAsync(value, params);
    if (parsed.success) return parsed;
    return { success: false, error: new z.ZodError(inputIssues(parsed.error.issues, fields)
      .map(issue => ({ code: 'custom', path: issue.path, message: issue.message }))) };
  };
  return guarded;
}
export class ApiBoundaryError extends ElevenLabsError {
  constructor(code: string, message: string, resolution: string, readonly issues: ValidationIssue[] = []) {
    super(message, code, resolution);
  }
  toJSON() {
    return { ok: false as const, code: this.code, resolution: this.resolution,
      error: this.issues.length ? wrapUntrusted(JSON.stringify({ message: this.message, issues: this.issues }), 'elevenlabs:api:validation') : this.message };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// Zod's record/object output drops __proto__. Parse dictionary entries as data instead.
function dictionary<T extends z.ZodTypeAny>(value: T) {
  return z.custom<Record<string, unknown>>(isRecord).transform(Object.entries)
    .pipe(z.array(z.tuple([z.string(), value])))
    .transform(entries => Object.assign(Object.create(null), Object.fromEntries(entries)) as Record<string, z.output<T>>);
}
const text = z.string().min(1);
const schemaValue = z.custom<JsonSchema>(value => typeof value === 'boolean' || isRecord(value));
export const effectsSchema = z.object({ readOnlyHint: z.boolean(), destructiveHint: z.boolean(), idempotentHint: z.boolean(), openWorldHint: z.boolean() }).strict();
const parameterRecord = z.object({ type: z.literal('object'), properties: dictionary(schemaValue), required: z.array(text), additionalProperties: z.literal(false) }).strict();
const fileBinding = z.object({ field: text, kind: z.union([z.enum(['audio', 'document', 'image']), z.array(z.enum(['audio', 'document', 'image'])).nonempty()]), allowed_media_types: z.array(text).nonempty().optional(), max_bytes: z.number().int().positive().optional(), max_total_bytes: z.number().int().positive().safe().optional(), required: z.boolean(), schema: schemaValue }).strict();
// Only the binary media declared by admitted contracts are enabled. Extend after spec review.
export const binaryResponseMedia = Object.keys(binaryExtensions) as [string, ...string[]];
export const responseMediaSchema = z.enum(['application/json', 'text/plain', 'text/html', 'multipart/mixed', 'audio/*', ...binaryResponseMedia]);
export function isBinaryResponseMedia(media: string | null, schema?: JsonSchema): boolean {
  return isBinaryMedia(media, isRecord(schema) ? schema : undefined);
}
const responseSchema = z.object({ status: z.number().int().min(200).max(299), media_type: responseMediaSchema.nullable(), schema: schemaValue.optional(),
  headers: z.array(z.string().regex(/^[!#$%&'*+.^_`|~a-z0-9-]+$/)).nonempty().optional(),
  base64_audio: base64AudioSchema.optional(), multipart: multipartResponseSchema.optional(), output_formats: z.object({ default: text, values: z.array(text).nonempty() }).strict().optional() }).strict();
const retryCheckSchema = z.union([text, z.object({ unavailable_reason: text }).strict()]);
const operationSchema = z.object({
  operation_id: z.string().regex(/^[a-zA-Z0-9_]+$/), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/'), family: text.refine(value => Object.hasOwn(apiFamilies, value)),
  milestone: z.union([z.literal(1), z.literal(7), z.literal(8), z.literal(9), z.literal(10)]), profile: profileSchema, tool: text, effects: effectsSchema, effect_reason: text, check_before_retry: retryCheckSchema, reviewed_post_read: text.optional(), reviewed_patch_delete: text.optional(), reviewed_get_create: text.optional(),
  retry_check: z.union([text, z.object({ unavailable_reason: text.trim().min(1) }).strict()]).optional(),
  optional_header_omissions: z.array(z.object({ name: z.string().regex(/^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/).refine(name => !['xi-api-key', 'content-type', 'content-length'].includes(name.toLowerCase())), reason: text.trim().min(1) }).strict()).nonempty().optional(),
  sensitive_request_fields: z.array(z.array(text).nonempty()).nonempty().optional(),
  credential_return_fields: z.array(z.array(text)).nonempty().optional(),
  sensitive_response_fields: z.array(z.array(text).nonempty()).nonempty().optional(), effect_note: text.optional(), manual_pagination: text.optional(),
  summary: z.string(), description: z.string(), deprecated: z.boolean(),
  parameters: z.object({ path: parameterRecord, query: parameterRecord, query_serialization: dictionary(z.literal('form-explode')) }).strict(),
  request: z.object({ media_type: z.enum(['application/json', 'multipart/form-data']).nullable(), required: z.boolean(), schema: schemaValue.optional(), files: z.array(fileBinding).optional(), fields: dictionary(z.enum(['scalar', 'repeated', 'json'])).optional() }).strict(),
  responses: z.array(responseSchema).nonempty(), pagination: z.object({ request: z.literal('cursor'), response: z.literal('next_cursor') }).strict().nullable(),
  timeout: z.enum(['standard', 'long']), authentication: z.object({ header: z.literal('xi-api-key'), supplied_by: z.literal('connector') }).strict(),
  search_aliases: z.array(text), rank: z.number().int(), follow_ups: z.array(text), examples: z.array(dictionary(z.unknown())),
}).strict();
export type ApiOperation = z.infer<typeof operationSchema>;
export function operationReference(op: ApiOperation, source?: ApiOperation): string {
  const parameters = [
    ...[...op.path.matchAll(/\{([^{}]+)\}/g)].map(([, name]) => `path_params.${name}`),
    ...op.parameters.query.required.map(name => `query_params.${name}`),
    ...Object.keys(op.parameters.query.properties)
      .filter(name => source?.parameters.path.required.includes(name) && !op.parameters.query.required.includes(name))
      .map(name => `query_params.${name} optional`),
  ];
  return `${op.operation_id}${parameters.length ? ` (${parameters.join(', ')})` : ''}`;
}
export type ApiResponseDescriptor = z.infer<typeof responseSchema>;
interface PaginationFields { hasMoreRequired: boolean; cursorRequired: boolean }
const paginationFields = new WeakMap<ApiOperation, PaginationFields>();
const paginationObjectMetadata = z.object({ type: z.literal('object'), properties: dictionary(schemaValue), required: z.array(text).optional() }).passthrough();
export function paginationFieldsFor(op: ApiOperation): PaginationFields {
  const fields = paginationFields.get(op);
  if (!fields) invalid('Missing checked pagination projection metadata.');
  return fields;
}

const aliasProperties = z.object({ llm_model: z.literal('llm'), knowledge_base_document_ids: z.literal('knowledge_base') }).strict();
const catalogSchema = z.object({
  source: z.object({ url: z.literal('https://api.elevenlabs.io/openapi.json'), retrieved_at: z.string().datetime({ offset: true }), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(), paths: z.number().int().positive(), operations: z.number().int().positive() }).strict(),
  compatibility_overlay: z.object({
    schema_constraints: text, enum_snapshot_date: z.literal('2026-11-08'), enum_error_advice: text, alias_behavior: text,
    forbidden_aliases: z.tuple([
      z.object({ operation_ids: z.tuple([z.literal('create_agent_route'), z.literal('patch_agent_settings_route')]), prompt_path: z.tuple([z.literal('body'), z.literal('conversation_config'), z.literal('agent'), z.literal('prompt')]), own_properties: aliasProperties, reason: text }).strict(),
      z.object({ operation_ids: z.tuple([z.literal('run_agent_test_suite_route')]), prompt_path: z.tuple([z.literal('body'), z.literal('agent_config_override'), z.literal('conversation_config'), z.literal('agent'), z.literal('prompt')]), own_properties: aliasProperties, reason: text }).strict(),
    ]),
  }).strict(),
  schema_metadata_keywords: z.tuple(['example', 'discriminator', 'optional', 'name', 'embed', 'max_items', 'x-fern-enum', 'x-convai-client-override', 'x-fern-ignore', 'x-convai-soft-override-disallowed', 'x-convai-language-override', 'x-convai-runtime-override', 'x-convai-override-disallowed'].map(value => z.literal(value)) as [z.ZodLiteral<string>, ...z.ZodLiteral<string>[]]),
  schema_formats: z.tuple([z.literal('date'), z.literal('date-time'), z.literal('uri'), z.literal('zoneinfo')]),
  validator_options: z.object({ strict: z.literal(true), strictTypes: z.literal(false), strictTuples: z.literal(true), strictRequired: z.literal(true), allowUnionTypes: z.literal(false), allErrors: z.literal(true), coerceTypes: z.literal(false), useDefaults: z.literal(false), removeAdditional: z.literal(false) }).strict(),
  operations: z.array(operationSchema).nonempty(), $defs: dictionary(schemaValue),
}).strict();
export type ApiCatalog = z.infer<typeof catalogSchema>;

const schemaMaps = ['properties', 'patternProperties', '$defs', 'dependentSchemas'] as const;
const schemaArrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
const schemaSingles = ['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'] as const;
const nodeSchema = z.object({
  ...Object.fromEntries(schemaMaps.map(key => [key, dictionary(schemaValue).optional()])),
  ...Object.fromEntries(schemaArrays.map(key => [key, z.array(schemaValue).optional()])),
  ...Object.fromEntries(schemaSingles.map(key => [key, schemaValue.optional()])),
  ...Object.fromEntries(['title', 'description', '$schema', '$id', '$anchor', '$comment', 'contentEncoding', 'contentMediaType', 'pattern'].map(key => [key, z.string().optional()])),
  ...Object.fromEntries(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minContains', 'maxContains', 'minProperties', 'maxProperties'].map(key => [key, z.number().finite().optional()])),
  ...Object.fromEntries(['readOnly', 'writeOnly', 'deprecated', 'nullable', 'uniqueItems'].map(key => [key, z.boolean().optional()])),
  ...Object.fromEntries(['default', 'const', 'example', 'optional', 'name', 'embed', 'max_items', 'x-fern-enum', 'x-convai-client-override', 'x-fern-ignore', 'x-convai-soft-override-disallowed', 'x-convai-language-override', 'x-convai-runtime-override', 'x-convai-override-disallowed'].map(key => [key, z.unknown().optional()])),
  $ref: text.optional(), type: z.union([z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']), z.array(z.string())]).optional(),
  format: z.enum(['date', 'date-time', 'uri', 'zoneinfo', 'binary']).optional(),
  required: z.array(z.string()).optional(), dependentRequired: dictionary(z.array(z.string())).optional(),
  enum: z.array(z.unknown()).optional(), examples: z.array(z.unknown()).optional(),
  discriminator: z.object({ propertyName: text, mapping: dictionary(text).optional() }).strict().optional(),
}).strict();

function invalid(detail: string): never {
  throw new ApiBoundaryError('CATALOG_INVALID', 'The local API catalogue is invalid.', 'Ask the connector maintainer to rebuild the connector from a consistent, reviewed catalogue. If unsure who that is, contact whoever manages your connector installation.', [{ path: [], keyword: 'catalogue', message: detail }]);
}
function sensitivePathExists(schema: JsonSchema | undefined, path: readonly string[], catalog: ApiCatalog, seen = new Set<string>()): boolean {
  if (!isRecord(schema)) return false;
  if (!path.length) return true;
  if (typeof schema.$ref === 'string' && !seen.has(schema.$ref)) {
    const next = new Set(seen); next.add(schema.$ref);
    if (sensitivePathExists(catalog.$defs[definitionName(schema.$ref)], path, catalog, next)) return true;
  }
  if (['allOf', 'anyOf', 'oneOf'].some(key => Array.isArray(schema[key]) && schema[key].some(branch => sensitivePathExists(branch as JsonSchema, path, catalog, new Set(seen))))) return true;
  const [field, ...rest] = path;
  if (field === '*') return [schema.items, schema.additionalProperties].some(child => sensitivePathExists(child as JsonSchema, rest, catalog));
  return isRecord(schema.properties) && Object.hasOwn(schema.properties, field) && sensitivePathExists(schema.properties[field] as JsonSchema, rest, catalog);
}
function responseProperties(schema: JsonSchema | undefined, catalog: ApiCatalog, seen = new Set<string>()): string[] {
  if (!isRecord(schema)) return [];
  const names = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  if (typeof schema.$ref === 'string' && !seen.has(schema.$ref)) {
    const next = new Set(seen); next.add(schema.$ref);
    names.push(...responseProperties(catalog.$defs[definitionName(schema.$ref)], catalog, next));
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(schema[key])) {
    for (const branch of schema[key]) names.push(...responseProperties(branch as JsonSchema, catalog, new Set(seen)));
  }
  return names;
}
const unsupportedPagination = new Set(['offset', 'skip', 'limit', 'page', 'page_number', 'page_index', 'page_token', 'page_key', 'page_cursor',
  'next_page_token', 'start_after', 'start_after_history_item_id', 'last_doc', 'next_doc', 'next_page', 'next_token',
  'after', 'before', 'starting_after', 'ending_before', 'continuation', 'continuation_token', 'continuationToken', 'pagination', 'paging']);
export function enumGuidance(catalog: ApiCatalog): string {
  return `Use an allowed value for this enum in the ${catalog.compatibility_overlay.enum_snapshot_date} snapshot. Inspect the field schema or a named definition through elevenlabs_discover_api. Ask the connector maintainer to refresh the reviewed API catalogue if the provider added a value. If unsure who that is, contact whoever manages your connector installation.`;
}
export function definitionName(ref: string): string {
  if (!/^#\/\$defs\/[^/]+$/.test(ref) || /~(?![01])/.test(ref)) invalid('Unsupported local schema reference.');
  return ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
}
export function schemaChildren(schema: Record<string, unknown>): [string, JsonSchema][] {
  return [
    ...schemaMaps.flatMap(key => isRecord(schema[key]) ? Object.entries(schema[key]).map(([name, child]) => [`${key}/${name}`, child as JsonSchema] as [string, JsonSchema]) : []),
    ...schemaArrays.flatMap(key => Array.isArray(schema[key]) ? schema[key].map((child, index) => [`${key}/${index}`, child as JsonSchema] as [string, JsonSchema]) : []),
    ...schemaSingles.flatMap(key => Object.hasOwn(schema, key) ? [[key, schema[key] as JsonSchema] as [string, JsonSchema]] : []),
  ];
}
export function mapSchemaChildren(schema: Record<string, unknown>, map: (child: JsonSchema) => JsonSchema): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (schemaMaps.includes(key as typeof schemaMaps[number]) && isRecord(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, map(child as JsonSchema)]))];
    if (schemaArrays.includes(key as typeof schemaArrays[number]) && Array.isArray(value)) return [key, value.map(child => map(child as JsonSchema))];
    if (schemaSingles.includes(key as typeof schemaSingles[number])) return [key, map(value as JsonSchema)];
    return [key, value];
  }));
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

/** Pure boundary for committed data and corrupt-catalogue tests; never fetches or resolves paths. */
export function validateApiCatalog(raw: unknown): ApiCatalog {
  let candidate: unknown;
  try { candidate = structuredClone(raw); } catch { invalid('Catalogue data could not be cloned.'); }
  const parsed = catalogSchema.safeParse(candidate);
  if (!parsed.success) invalid(`Invalid consumed metadata at ${parsed.error.issues.map(issue => issue.path.join('.')).slice(0, 5).join(', ')}.`);
  const catalog = parsed.data;
  function checkRef(ref: string) {
    if (!Object.hasOwn(catalog.$defs, definitionName(ref))) invalid(`Missing definition: ${ref}`);
  }
  function walk(schema: JsonSchema, location: string, binary = false): void {
    if (typeof schema === 'boolean') return;
    if (Object.hasOwn(schema, 'unevaluatedProperties')) invalid(`Unsupported schema keyword unevaluatedProperties at ${location}; support requires a reviewed validator correction.`);
    if (!nodeSchema.safeParse(schema).success) invalid('Invalid or unsupported JSON Schema keyword.');
    if (typeof schema.$ref === 'string') checkRef(schema.$ref);
    if (schema.format === 'binary' && (!binary || schema.type !== 'string')) invalid('Binary schema outside a declared file operand.');
    if (isRecord(schema.discriminator) && isRecord(schema.discriminator.mapping)) Object.values(schema.discriminator.mapping).forEach(ref => checkRef(String(ref)));
    schemaChildren(schema).forEach(([name, child]) => walk(child, `${location}/${name}`, binary));
  }
  Object.entries(catalog.$defs).forEach(([name, schema]) => walk(schema, `$defs/${name}`));
  const byId = new Map(catalog.operations.map(op => [op.operation_id, op]));
  if (byId.size !== catalog.operations.length) invalid('Duplicate operation ID.');
  for (const op of catalog.operations) {
    if (op.tool !== API_TOOLS[op.profile]) invalid('Operation profile/tool mismatch.');
    const expected = { readOnlyHint: ['read', 'query_knowledge'].includes(op.profile), destructiveHint: ['change', 'delete', 'tests', 'place_call'].includes(op.profile), idempotentHint: op.profile === 'read', openWorldHint: true };
    if (Object.keys(expected).some(key => op.effects[key as keyof typeof expected] !== expected[key as keyof typeof expected])) invalid('Operation profile/effect mismatch.');
    const reviewedGetCreate = reviewedGetCreates.includes(op.operation_id);
    if ((op.method === 'GET' && op.profile !== 'read' && !(op.profile === 'create' && op.reviewed_get_create && reviewedGetCreate)) || (['PUT', 'PATCH'].includes(op.method) && op.profile !== 'change' && !(op.method === 'PATCH' && op.profile === 'delete' && op.reviewed_patch_delete)) || (op.method === 'DELETE' && op.profile !== 'delete') || (op.method === 'POST' && op.profile === 'read' && !op.reviewed_post_read)) invalid('Method/effect mismatch.');
    if (op.reviewed_get_create !== undefined && (op.method !== 'GET' || op.profile !== 'create' || !reviewedGetCreate)) invalid('Misplaced reviewed GET create.');
    if (op.reviewed_patch_delete !== undefined && (op.method !== 'PATCH' || op.profile !== 'delete')) invalid('Misplaced reviewed PATCH delete.');
    if (op.reviewed_post_read !== undefined && (op.method !== 'POST' || op.profile !== 'read')) invalid('Misplaced reviewed POST read.');
    if (credentialIssuers.includes(op.operation_id) && !op.credential_return_fields) invalid('Missing credential return fields.');
    if (op.operation_id === 'create_realtime_session' && [op.sensitive_request_fields, op.sensitive_response_fields].some(paths => !paths?.some(path => JSON.stringify(path) === JSON.stringify(realtimeAuthorizationPath)))) invalid('Missing realtime authorization protection.');
    const queries = Object.keys(op.parameters.query.properties);
    const properties = op.responses.flatMap(response => responseProperties(response.schema, catalog));
    const documents = queries.includes('last_doc') && properties.includes('next_doc') && properties.includes('has_more');
    const history = queries.includes('start_after_history_item_id') && properties.includes('last_history_item_id') && properties.includes('has_more');
    const tokens = queries.includes('next_page_token') && properties.includes('next_page_token') && properties.includes('has_more');
    const pagingNames = [...queries, ...properties].filter(name => unsupportedPagination.has(name));
    if (op.manual_pagination !== undefined && (op.method !== 'GET' || op.profile !== 'read' || op.pagination !== null
      || (!documents && !tokens && !history && !['page', 'limit'].some(name => queries.includes(name)))
      || queries.includes('cursor') || properties.includes('next_cursor')
      || pagingNames.some(name => !['page', 'limit', ...(documents ? ['last_doc', 'next_doc'] : []), ...(tokens ? ['next_page_token'] : []), ...(history ? ['start_after_history_item_id'] : [])].includes(name)))) invalid('Invalid manual pagination.');
    if (op.manual_pagination === undefined && pagingNames.length) invalid('Undeclared manual pagination.');
    if (op.optional_header_omissions && new Set(op.optional_header_omissions.map(header => header.name.toLowerCase())).size !== op.optional_header_omissions.length) invalid('Duplicate optional header omission.');
    for (const check of [op.check_before_retry, op.retry_check]) {
      if (typeof check !== 'string') continue;
      const retryOperation = byId.get(check);
      if (retryOperation?.profile !== 'read' || retryOperation.method !== 'GET') invalid('Retry check must be an admitted GET read.');
    }
    if (/[?#\u0000-\u0020\u007f]/.test(op.path) || op.path.startsWith('//') || op.path.split('/').some(part => part === '.' || part === '..')) invalid('Invalid operation path.');
    const placeholders = [...op.path.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]).sort();
    const keys = Object.keys(op.parameters.path.properties).sort();
    if (JSON.stringify(placeholders) !== JSON.stringify(keys) || JSON.stringify([...op.parameters.path.required].sort()) !== JSON.stringify(keys)) invalid('Path operand bindings mismatch.');
    if (JSON.stringify(Object.keys(op.parameters.query.properties).sort()) !== JSON.stringify(Object.keys(op.parameters.query_serialization).sort())) invalid('Query serialization bindings mismatch.');
    for (const id of op.follow_ups) if (id === op.operation_id || byId.get(id)?.profile !== 'read') invalid('Follow-up must be a different admitted read.');
    const location = `operations/${op.operation_id}`;
    walk(op.parameters.path, `${location}/parameters/path`); walk(op.parameters.query, `${location}/parameters/query`);
    if ((op.request.media_type === null) !== (op.request.schema === undefined) || (op.request.media_type === null && op.request.required)) invalid('Request media/schema mismatch.');
    if (op.request.schema !== undefined) walk(op.request.schema, `${location}/request/schema`);
    const files = op.request.files ?? [];
    if (files.length && (!['read', 'create', 'change', 'run_job'].includes(op.profile) || op.request.media_type !== 'multipart/form-data')) invalid('File operand/profile mismatch.');
    if (new Set(files.map(file => file.field)).size !== files.length) invalid('Duplicate file binding.');
    const resolveMultipart = (schema: unknown): unknown => isRecord(schema) && typeof schema.$ref === 'string' ? resolveMultipart(catalog.$defs[definitionName(schema.$ref)]) : schema;
    if (op.request.media_type === 'multipart/form-data') {
      const root = resolveMultipart(op.request.schema);
      if (!isRecord(root) || !isRecord(root.properties) || !op.request.fields
        || JSON.stringify(Object.keys(root.properties).sort()) !== JSON.stringify(Object.keys(op.request.fields).sort())
        || Object.entries(root.properties).some(([field, schema]) => op.request.fields![field] !== multipartFieldEncoding(schema, resolveMultipart))) invalid('Multipart field serialization mismatch.');
    } else if (op.request.fields !== undefined) invalid('Misplaced multipart serialization.');
    files.forEach((file, index) => {
      if (!binaryFileShape(file.schema, resolveMultipart)) invalid('File binding does not declare a binary operand.');
      walk(file.schema, `${location}/request/files/${index}/schema`, true);
    });
    if (new Set(op.responses.map(response => `${response.status}:${response.media_type}`)).size !== op.responses.length) invalid('Duplicate response descriptor.');
    op.responses.forEach((response, index) => {
      if (response.output_formats) {
        const binding = response.output_formats;
        const query = op.parameters.query.properties.output_format;
        if ((response.media_type !== 'audio/mpeg' && !response.base64_audio) || !isRecord(query)
          || JSON.stringify(query.enum) !== JSON.stringify(binding.values) || query.default !== binding.default
          || !binding.values.includes(binding.default) || binding.values.some(format => !audioRepresentation(format))) invalid('Invalid reviewed output-format binding.');
      }
      if ((response.media_type === 'multipart/mixed') !== Boolean(response.multipart) || (response.multipart && response.base64_audio)) invalid('Invalid multipart response strategy.');
      if (response.base64_audio && (response.media_type !== 'application/json' || !sensitivePathExists(response.schema, response.base64_audio.array ? [response.base64_audio.array, '*', response.base64_audio.field] : [response.base64_audio.field], catalog))) invalid('Unbound base64 audio response.');
      if (response.media_type === null && response.schema !== undefined) invalid('Empty response declares a schema.');
      if (response.media_type === 'text/csv' && (!isRecord(response.schema) || response.schema.type !== 'string' || response.schema.format !== 'binary')) invalid('CSV requires a binary success schema.');
      if (response.schema !== undefined) walk(response.schema, `${location}/responses/${index}/schema`, isBinaryResponseMedia(response.media_type, response.schema) || response.media_type === 'audio/*' || Boolean(response.multipart));
    });
    for (const [paths, schemas] of [
      [op.sensitive_request_fields, [op.request.schema]],
      [op.sensitive_response_fields, op.responses.map(response => response.schema)],
      [op.credential_return_fields, op.responses.map(response => response.schema)],
    ] as const) {
      if (new Set(paths?.map(path => JSON.stringify(path))).size !== (paths?.length ?? 0)) invalid('Duplicate sensitive field.');
      for (const path of paths ?? []) if (!schemas.some(schema => sensitivePathExists(schema, path, catalog))) invalid('Unbound sensitive field.');
    }
    if (op.credential_return_fields?.some(path => !path.length) && !op.responses.some(response => isRecord(response.schema) && response.schema.type === 'string' && ['text/plain', 'text/html'].includes(response.media_type!))) invalid('Whole credential return requires scalar text.');
    for (const returned of op.credential_return_fields ?? []) {
      if ((op.sensitive_response_fields ?? []).some(hidden => hidden.length === returned.length && hidden.every((part, i) => part === returned[i] || part === '*' || returned[i] === '*'))) invalid('Overlapping credential return and sensitive response field.');
    }
    if (op.pagination) {
      if (!Object.hasOwn(op.parameters.query.properties, op.pagination.request)) invalid('Pagination operand missing.');
      if (op.responses.length !== 1 || op.responses[0].media_type !== 'application/json') invalid('Unsupported pagination response projection.');
      let schema = op.responses[0].schema;
      const seen = new Set<string>();
      while (isRecord(schema) && typeof schema.$ref === 'string') {
        const ref = schema.$ref;
        if (seen.has(ref)) invalid('Cyclic pagination object reference.');
        seen.add(ref);
        if (Object.keys(schema).some(key => !['$ref', 'title', 'description', ...catalog.schema_metadata_keywords].includes(key))) invalid('Unsupported constrained pagination reference.');
        schema = catalog.$defs[definitionName(ref)];
      }
      const metadata = paginationObjectMetadata.safeParse(schema);
      if (!metadata.success || !Object.hasOwn(metadata.data.properties, 'next_cursor')) invalid('Missing pagination response object or cursor.');
      paginationFields.set(op, { hasMoreRequired: metadata.data.required?.includes('has_more') ?? false, cursorRequired: metadata.data.required?.includes('next_cursor') ?? false });
    }
  }
  freeze(catalog);
  return catalog;
}

let catalogPromise: Promise<ApiCatalog> | undefined;
const operationIndexes = new WeakMap<ApiCatalog, Map<string, ApiOperation>>();
export function loadApiCatalog(): Promise<ApiCatalog> {
  return catalogPromise ??= import('./generated/api-catalog.js').then(module => validateApiCatalog(module.apiCatalog)).catch(error => {
    if (error instanceof ApiBoundaryError && error.code === 'CATALOG_INVALID') throw error;
    invalid('The generated API catalogue could not be loaded or validated.');
  });
}
export async function getOperation(operationId: string, profile?: ApiProfile): Promise<ApiOperation> {
  const catalog = await loadApiCatalog();
  let index = operationIndexes.get(catalog);
  if (!index) { index = new Map(catalog.operations.map(op => [op.operation_id, op])); operationIndexes.set(catalog, index); }
  const op = index.get(operationId);
  if (!op) throw new ApiBoundaryError('UNKNOWN_OPERATION', 'This operation is not admitted in the local API catalogue.', 'Use elevenlabs_discover_api to select an admitted operation ID.');
  if (profile !== undefined && op.profile !== profile) throw new ApiBoundaryError('WRONG_TOOL', `Use ${op.tool} for this operation.`, `Call ${op.tool} with the same operation_id.`);
  return op;
}

export const discoveryInputSchema = z.object({
  query: z.string().optional(), family: z.enum(discoveryFamilies).optional(),
  operation_id: text.optional(), definition: z.string().min(1).optional(),
  cursor: z.string().regex(/^(0|[1-9][0-9]*)$/, 'Use next_cursor from the previous discovery result.').refine(value => Number.isSafeInteger(Number(value)), 'Use next_cursor from the previous discovery result.').optional(),
  limit: z.number().int().min(1).max(25).default(10),
}).strict().superRefine((value, ctx) => {
  if (value.definition && !value.operation_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['definition'], message: 'definition requires operation_id.', params: { keyword: 'contract' } });
});
export const discoveryFamilyDescription = discoveryFamilies.join(', ');
export const operationContractGuidance = 'Operation IDs listed here or in receipts are names only. Before the first call to each operation in this conversation, call elevenlabs_discover_api with that operation_id to read its contract, unless a tool description or receipt already supplies the exact parameter names and locations. Never infer path_params, query_params or body fields from an operation name.';
const discoveryInstructions = operationContractGuidance + ' Start with elevenlabs_discover_api({query:"agents"}). family accepts ' + discoveryFamilyDescription + '; cursor is the previous discovery result\'s next_cursor; limit is 1–25. For a request contract, call elevenlabs_discover_api({operation_id:"create_agent_route"}); for a named definition, call elevenlabs_discover_api({operation_id:"create_agent_route",definition:"KnowledgeBaseLocator"}). Replace create_agent_route in both examples with the operation_id you intend to use. Use bare names from contract.definitions, without the #/$defs/ prefix.';
function family(op: ApiOperation): typeof discoveryFamilies[number] {
  if (op.profile === 'tests') return 'tests';
  if (op.profile === 'query_knowledge') return 'knowledge';
  return apiFamilies[op.family as keyof typeof apiFamilies];
}
function envelope(value: unknown, id: string): string {
  return wrapUntrusted(JSON.stringify(value), `elevenlabs:api:${id}`)!;
}
function listing(op: ApiOperation) {
  return { operation_id: op.operation_id, tool: op.tool, profile: op.profile, family: family(op), effects: op.effects,
    contract: envelope({ summary: op.summary, description: op.description }, op.operation_id) };
}
let lastDiscovery: { key: string; result: { operations: ReturnType<typeof listing>[]; total: number; next_cursor: string | null } } | undefined;
export async function discoverOperations(input: unknown = {}) {
  const parsed = discoveryInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiBoundaryError('VALIDATION_ERROR', 'Invalid API discovery input.', discoveryInstructions, inputIssues(parsed.error.issues, () => Object.keys(discoveryInputSchema.innerType().shape)));
  const args = parsed.data;
  if (args.operation_id) return describeOperation(args.operation_id, args.definition);
  const key = JSON.stringify(args);
  if (lastDiscovery?.key === key) return lastDiscovery.result;
  const tokens = (value: string) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const query = new Set(tokens(args.query ?? ''));
  const ranked = (await loadApiCatalog()).operations.filter(op => !args.family || family(op) === args.family).map(op => {
    const words = new Set(tokens([op.operation_id, op.summary, op.family, family(op), ...op.search_aliases].join(' ')));
    return { op, overlap: [...query].filter(word => words.has(word)).length };
  }).filter(item => query.size === 0 || item.overlap > 0).sort((a, b) => b.overlap - a.overlap || b.op.rank - a.op.rank || (a.op.operation_id < b.op.operation_id ? -1 : a.op.operation_id > b.op.operation_id ? 1 : 0));
  const offset = Number(args.cursor ?? 0);
  const result = { operations: ranked.slice(offset, offset + args.limit).map(({ op }) => listing(op)), total: ranked.length,
    next_cursor: offset + args.limit < ranked.length ? String(offset + args.limit) : null };
  freeze(result);
  lastDiscovery = { key, result };
  return result;
}

export function expandSchema(schema: JsonSchema, catalog: ApiCatalog, depth = 2): JsonSchema {
  if (typeof schema === 'boolean') return schema;
  if (typeof schema.$ref === 'string' && depth > 0) {
    const target = catalog.$defs[definitionName(schema.$ref)];
    const { $ref, ...siblings } = schema;
    return Object.keys(siblings).length ? { allOf: [expandSchema(target, catalog, depth - 1), expandSchema(siblings, catalog, depth - 1)] } : expandSchema(target, catalog, depth - 1);
  }
  if (depth === 0) return schema;
  return mapSchemaChildren(schema, child => expandSchema(child, catalog, depth));
}
const descriptions = new Map<string, ReturnType<typeof buildDescription>>();
export function reachableDefinitions(op: ApiOperation, catalog: ApiCatalog): string[] {
  const names = new Set<string>();
  function visit(schema: JsonSchema | undefined): void {
    if (!isRecord(schema)) return;
    const refs = [schema.$ref, ...Object.values(isRecord(schema.discriminator) && isRecord(schema.discriminator.mapping) ? schema.discriminator.mapping : {})];
    for (const ref of refs) {
      if (typeof ref !== 'string') continue;
      const name = definitionName(ref);
      if (names.has(name)) continue;
      names.add(name);
      visit(catalog.$defs[name]);
    }
    schemaChildren(schema).forEach(([, child]) => visit(child));
  }
  [op.parameters.path, op.parameters.query, op.request.schema,
    ...op.request.files?.map(file => file.schema) ?? [], ...op.responses.map(response => response.schema)].forEach(visit);
  return [...names].sort();
}
export async function describeOperation(operationId: string, definition?: string) {
  const op = await getOperation(operationId);
  const catalog = await loadApiCatalog();
  if (definition !== undefined && !Object.hasOwn(catalog.$defs, definition)) throw new ApiBoundaryError('UNKNOWN_DEFINITION', 'The named schema definition does not exist.', discoveryInstructions);
  const key = JSON.stringify([operationId, definition]);
  let result = descriptions.get(key);
  if (!result) { result = buildDescription(op, catalog, definition); descriptions.set(key, result); }
  return result;
}
async function buildDescription(op: ApiOperation, catalog: ApiCatalog, definition?: string) {
  const { examplesForOperation, validateRequest } = await import('./api-validation.js');
  const examples = examplesForOperation(op);
  for (const example of examples) {
    try { await validateRequest(op.profile, example, createRedactor([])); } catch { invalid('A discovery example does not satisfy the operation contract.'); }
  }
  const files = op.request.files;
  const effectNote = op.effect_note ? ` ${op.effect_note}` : '';
  const pagingNote = op.manual_pagination ? ` ${op.manual_pagination}` : '';
  const workspaceNote = ['update_settings_route', 'update_dashboard_settings_route'].includes(op.operation_id) ? ' This operation changes settings for the whole workspace.' : '';
  const result = { ...listing(op), instructions: `${profileInstructions[op.profile]} ${discoveryInstructions}${workspaceNote}${effectNote}${pagingNote}`,
    contract: envelope({ summary: op.summary, description: op.description, deprecated: op.deprecated, method: op.method, path: op.path,
      request: { path_params: expandSchema(op.parameters.path, catalog), query_params: expandSchema(op.parameters.query, catalog), body: op.request.schema === undefined ? undefined : expandSchema(op.request.schema, catalog), ...(files?.length ? { files } : {}) },
      ...(definition === undefined ? {} : { definition: { name: definition, schema: expandSchema(catalog.$defs[definition], catalog) } }),
      ...(op.optional_header_omissions ? { optional_header_omissions: op.optional_header_omissions } : {}),
      definitions: reachableDefinitions(op, catalog), responses: op.responses, examples,
      ...(examples.length ? { example_notes: [
        'Replace *_example IDs with IDs obtained from the corresponding resource list or create operations found through discovery. list_voices supplies voice IDs.',
        ...(files?.length ? ['A file_path such as ./guide.pdf names a file on the connector\'s machine, relative to the connector\'s working directory.'] : []),
        ...(op.operation_id === 'create_agent_response_test_route' ? ['Mocks supply configured tool results instead of real tool calls. This saved-test example explicitly sets tool_mock_config and tool_mock_overrides; inspect those fields when configuring a saved test. Running a saved test does not itself configure mocks.'] : []),
      ] } : {}),
      validation: { snapshot_date: catalog.compatibility_overlay.enum_snapshot_date, enums: enumGuidance(catalog), aliases: catalog.compatibility_overlay.alias_behavior, forbidden_aliases: catalog.compatibility_overlay.forbidden_aliases,
        alias_guidance: 'At the prompt paths listed in forbidden_aliases, use llm instead of llm_model, and an array of knowledge-base locator objects instead of knowledge_base_document_ids; inspect the KnowledgeBaseLocator definition. These names remain allowed as data keys elsewhere. The connector does not rename fields or fetch and merge an existing configuration for you.',
      },
    }, op.operation_id) };
  freeze(result);
  return result;
}
const profileInstructions: Record<ApiProfile, string> = {
  read: 'FREE: local validation; provider reads may have provider limits. WHEN TO USE: inspect resources. RELATED TOOLS: elevenlabs_discover_api; list_voices supplies voice IDs. EXAMPLE: elevenlabs_discover_api({operation_id:"get_agent_route"}), then call elevenlabs_read_resource with path_params.agent_id.',
  create: 'COST: provider creation or indexing may spend credits. WHEN TO USE: create resources. URL knowledge creation asks the provider to fetch the URL; local uploads use files only. RELATED TOOLS: elevenlabs_read_resource. EXAMPLE: elevenlabs_discover_api({operation_id:"create_agent_route"}) before elevenlabs_create_resource.',
  change: 'COST: provider work may spend credits. WHEN TO USE: explicitly modify resources; updates can overwrite or replace content and arrays. The connector does not fetch or merge existing configuration, and does not guarantee that omitted PATCH fields survive at the provider. RELATED TOOLS: elevenlabs_read_resource. EXAMPLE: elevenlabs_discover_api({operation_id:"patch_agent_settings_route"}) before elevenlabs_change_resource.',
  delete: 'COST: provider limits apply. WHEN TO USE: explicitly delete a resource. RELATED TOOLS: elevenlabs_read_resource. EXAMPLE: elevenlabs_discover_api({operation_id:"delete_agent_route"}) before elevenlabs_delete_resource.',
  tests: 'COST: Tests may spend credits and invoke real integrations unless the caller explicitly configures mocks. Before running, use elevenlabs_read_resource to inspect the saved Test (get_agent_response_test_route), target agent (get_agent_route) and referenced tools (get_tool_route) for external actions. Check explicit mock configuration, including tool_mock_config, tool_mock_overrides and fallback behavior where supported. WHEN TO USE: run, cancel or resubmit saved Tests. RELATED TOOLS: elevenlabs_read_resource. EXAMPLE: elevenlabs_discover_api({operation_id:"run_agent_test_suite_route"}) before elevenlabs_run_agent_tests; running a saved Test does not itself configure mocks.',
  run_job: 'COST: media processing may spend credits. WHEN TO USE: requested generation or processing. RELATED TOOLS: elevenlabs_discover_api, elevenlabs_read_resource. EXAMPLE: elevenlabs_discover_api({operation_id:"text_to_speech_full"}) before elevenlabs_run_job.',
  place_call: 'COST: calls and provider services may incur charges. WHEN TO USE: explicitly place or schedule recipient calls, send WhatsApp template messages, retry failed or unanswered batch recipients, or register a live call connection. Provider acceptance is not proof of an answered call or delivered message. Returned TwiML is connection instructions, not proof of a connected call. No automatic retries or polling. RELATED TOOLS: elevenlabs_discover_api, elevenlabs_read_resource. EXAMPLE: elevenlabs_discover_api({operation_id:"register_twilio_call"}) before elevenlabs_place_call.',
  query_knowledge: 'COST: knowledge queries may spend credits. WHEN TO USE: retrieve knowledge without creating a conversation. RELATED TOOLS: elevenlabs_read_resource. EXAMPLE: elevenlabs_discover_api({operation_id:"query_agent_knowledge_base_rag_route"}) before elevenlabs_query_knowledge.',
};
