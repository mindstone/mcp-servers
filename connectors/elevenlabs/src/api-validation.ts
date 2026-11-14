import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import formats = require('ajv-formats');
import { z } from 'zod';
import { parseApiResponse } from './api-schemas.js';
import {
  ApiBoundaryError, effectsSchema, enumGuidance, getOperation, inputIssues, isRecord, loadApiCatalog, mapSchemaChildren, paginationFieldsFor,
  type ApiCatalog, type ApiOperation, type ApiProfile, type ApiResponseDescriptor,
  type JsonSchema, type ValidationIssue,
} from './api-catalog.js';
import { wrapUntrusted } from './untrusted-content.js';

const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
function ownRecord<T>(schema: z.ZodType<T>) {
  return z.custom<Record<string, T>>(isRecord).superRefine((value, ctx) => {
    for (const [key, item] of Object.entries(value)) {
      const parsed = schema.safeParse(item);
      if (!parsed.success) parsed.error.issues.forEach(issue => ctx.addIssue({ ...issue, path: [key, ...issue.path] }));
    }
  });
}
const pathOperand = z.string().min(1).refine(value => value !== '.' && value !== '..' && !/[\u0000-\u001f\u007f]/.test(value), 'Use a nonempty path operand other than "." or "..", without control characters such as newlines.');
const executionEnvelopeSchema = z.object({
  operation_id: z.string().min(1),
  path_params: ownRecord(pathOperand).describe('Declared path parameter names and nonempty string values; inspect this operation with elevenlabs_discover_api.').optional(),
  query_params: ownRecord(z.union([scalar, z.null(), z.array(scalar)])).describe('Declared query parameter names with string, number, boolean, null or scalar-array values. Arrays repeat; null is omitted.').optional(),
  body: z.unknown().describe('The provider request body for this operation, preserving its schema, arrays and nulls. Omit for bodyless operations; local file operands belong in files.').optional(),
  files: z.array(z.object({ field: z.string().min(1), file_path: z.string().min(1) }).strict()).optional(),
}).strict();
export const executionInputSchema = z.preprocess(value => isRecord(value) ? Object.fromEntries(Object.entries(value)) : value, executionEnvelopeSchema);
export type ApiExecutionInput = z.infer<typeof executionInputSchema>;

/** Own-property copies are validation-only; forwarding retains the original caller values. */
function ownData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ownData);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ownData(item)]));
}
function pointerParts(pointer: string): string[] {
  return pointer.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}
function graphIssues(errors: ErrorObject[] | null | undefined, prefix: string[], enumAdvice: string): ValidationIssue[] {
  return (errors ?? []).map(error => ({
    path: [...prefix, ...pointerParts(error.instancePath), ...(['required', 'additionalProperties'].includes(error.keyword) ? [String(error.params.missingProperty ?? error.params.additionalProperty)] : [])],
    keyword: error.keyword, message: error.keyword === 'enum' ? enumAdvice : `Provider constraint ${error.keyword} failed.`,
  }));
}
function argumentFailure(issues: ValidationIssue[]): ApiBoundaryError {
  return new ApiBoundaryError('VALIDATION_ERROR', 'The API arguments do not satisfy the local contract.', 'Correct the reported fields. Inspect allowed values with elevenlabs_discover_api using this operation_id; use a bare name from contract.definitions for a definition lookup. Ask the connector maintainer to refresh the reviewed catalogue dated 2026-11-08 if the provider added a value. If unsure who that is, contact whoever manages your connector installation.', issues);
}
function executionIssues(issues: z.ZodIssue[]): ValidationIssue[] {
  return inputIssues(issues, path => path[0] === 'files' ? ['field', 'file_path'] : Object.keys(executionEnvelopeSchema.shape));
}
const catalogueRepair = 'Ask the connector maintainer to rebuild the connector from a consistent, reviewed catalogue. If unsure who that is, contact whoever manages your connector installation.';
const responseRepair = 'A request returning a 2xx response may have completed even when its response is invalid. Check the result through elevenlabs_read_resource before retrying a mutation. Report the operation_id, status and media type when available, and the structured error to the connector maintainer. If unsure who that is, contact whoever manages your connector installation. Keep raw response content private.';

function compilationSchema(schema: JsonSchema): JsonSchema {
  if (typeof schema === 'boolean') return schema;
  const copy = mapSchemaChildren(schema, compilationSchema);
  if (isRecord(copy.patternProperties) && Object.hasOwn(copy.patternProperties, '__proto__')) {
    // Ajv skips this dictionary key; grouping preserves the unanchored regex meaning.
    const pattern = '(?:__proto__)';
    const patterns = copy.patternProperties;
    copy.patternProperties = Object.fromEntries([
      ...Object.entries(patterns).filter(([key]) => key !== '__proto__' && key !== pattern),
      [pattern, Object.hasOwn(patterns, pattern) ? { allOf: [patterns[pattern], patterns.__proto__] } : patterns.__proto__],
    ]);
  }
  if (isRecord(copy.properties) && Object.hasOwn(copy.properties, '__proto__')) {
    // Ajv skips properties.__proto__; an exact native pattern restores the same constraint.
    const pattern = '^__proto__$(?![\\s\\S])';
    const patterns = isRecord(copy.patternProperties) ? copy.patternProperties : {};
    const property = copy.properties.__proto__;
    copy.properties = Object.fromEntries(Object.entries(copy.properties).filter(([key]) => key !== '__proto__'));
    copy.patternProperties = Object.fromEntries([...Object.entries(patterns).filter(([key]) => key !== pattern),
      [pattern, Object.hasOwn(patterns, pattern) ? { allOf: [patterns[pattern], property] } : property]]);
    if (Array.isArray(copy.required) && copy.required.includes('__proto__')) {
      // Keep strictRequired without a properties/patternProperties overlap in the parent.
      copy.required = copy.required.filter(key => key !== '__proto__');
      copy.allOf = [...(Array.isArray(copy.allOf) ? copy.allOf : []),
        { required: ['__proto__'], properties: Object.fromEntries([['__proto__', true]]) }];
    }
  }
  return copy;
}

export class ApiValidator {
  private readonly ajv: Ajv2020;
  private readonly compiled = new Map<string, ValidateFunction>();
  private readonly requests = new Map<string, ReturnType<typeof executionInputSchema.superRefine>>();
  private readonly roots: Record<string, JsonSchema>;
  private readonly graphId = 'urn:elevenlabs:api:catalogue';

  constructor(private readonly catalog: ApiCatalog) {
    this.ajv = new Ajv2020({ ...catalog.validator_options, ownProperties: true });
    formats.default(this.ajv, { mode: 'full', formats: ['date', 'date-time', 'uri'] });
    this.ajv.addFormat('zoneinfo', { type: 'string', validate(value: string) {
      try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
    } });
    for (const keyword of catalog.schema_metadata_keywords) this.ajv.addKeyword({ keyword, valid: true });
    this.roots = Object.assign(Object.create(null) as Record<string, JsonSchema>, catalog.$defs);
    for (const op of catalog.operations) {
      this.addRoot(op, 'path', op.parameters.path); this.addRoot(op, 'query', op.parameters.query);
      if (op.request.schema !== undefined) this.addRoot(op, 'body', op.request.schema);
      op.responses.forEach((response, index) => {
        if (response.schema !== undefined) this.addRoot(op, this.responseRoot(op, index), response.schema);
      });
    }
    try { this.ajv.addSchema({ $id: this.graphId, $defs: Object.fromEntries(Object.entries(this.roots).map(([name, schema]) => [name, compilationSchema(schema)])) }); } catch {
      throw new ApiBoundaryError('CATALOG_INVALID', 'The local API schema graph is invalid.', catalogueRepair);
    }
  }
  private responseRoot(op: ApiOperation, index: number): string {
    const status = op.responses[index].status;
    return `response.${status}${op.responses.filter(response => response.status === status).length > 1 ? `.${index}` : ''}`;
  }
  private addRoot(op: ApiOperation, suffix: string, schema: JsonSchema) {
    const name = `op.${op.operation_id}.${suffix}`;
    if (Object.hasOwn(this.roots, name)) throw new ApiBoundaryError('CATALOG_INVALID', 'Duplicate API schema root.', catalogueRepair);
    this.roots[name] = schema;
  }
  private compile(op: ApiOperation, suffix: string): ValidateFunction {
    const name = `op.${op.operation_id}.${suffix}`;
    const cached = this.compiled.get(name);
    if (cached) return cached;
    try {
      const validate = this.ajv.getSchema(`${this.graphId}#/$defs/${name}`);
      if (!validate) throw new Error('Missing schema root.');
      this.compiled.set(name, validate);
      return validate;
    } catch {
      throw new ApiBoundaryError('CATALOG_INVALID', 'The local API schema could not be compiled.', catalogueRepair);
    }
  }
  requestSchema(op: ApiOperation) {
    const cached = this.requests.get(op.operation_id);
    if (cached) return cached;
    // Compilation stays outside the refinement: catalogue failures retain CATALOG_INVALID.
    const roots = [
      { suffix: 'path', field: 'path_params', validate: this.compile(op, 'path') },
      { suffix: 'query', field: 'query_params', validate: this.compile(op, 'query') },
      ...(op.request.schema === undefined ? [] : [{ suffix: 'body', field: 'body', validate: this.compile(op, 'body') }]),
    ];
    const schema = executionInputSchema.superRefine((input, ctx) => {
      const issue = (path: (string | number)[], message: string, keyword = 'contract') => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message, params: { keyword } });
      if (input.operation_id !== op.operation_id) issue(['operation_id'], 'Operation ID does not match this contract.');
      for (const root of roots) {
        let value: unknown = input.body;
        if (root.field === 'path_params') value = input.path_params ?? {};
        else if (root.field === 'query_params') value = input.query_params ?? {};
        else if (value === undefined && op.request.media_type === 'multipart/form-data') value = {};
        if (root.suffix === 'body' && value === undefined && !op.request.required) continue;
        if (!root.validate(ownData(value))) {
          for (const error of graphIssues(root.validate.errors, [root.field], enumGuidance(this.catalog))) issue(error.path, error.message, error.keyword);
        }
      }
      if (op.request.media_type === null && Object.hasOwn(input, 'body')) issue(['body'], 'This operation declares no request body.');
      if (op.request.required && op.request.media_type === 'application/json' && input.body === undefined) issue(['body'], 'The provider requires a request body.');
      for (const rule of this.catalog.compatibility_overlay.forbidden_aliases) {
        if (!(rule.operation_ids as readonly string[]).includes(op.operation_id)) continue;
        let anchor: unknown = input;
        for (const key of rule.prompt_path) anchor = isRecord(anchor) && Object.hasOwn(anchor, key) ? anchor[key] : undefined;
        if (!isRecord(anchor)) continue;
        for (const [alias, correction] of Object.entries(rule.own_properties)) {
          if (Object.hasOwn(anchor, alias)) issue([...rule.prompt_path, alias], `Use ${[...rule.prompt_path, correction].join('.')}${alias === 'knowledge_base_document_ids' ? ' with structured knowledge locators' : ''}.`, 'forbidden_alias');
        }
      }
      if (input.files !== undefined && !['create', 'change'].includes(op.profile)) issue(['files'], 'This profile does not accept file operands.');
      if (input.files !== undefined && op.request.media_type !== 'multipart/form-data') issue(['files'], 'This operation declares no multipart file operands.');
      const bindings = op.request.files ?? [];
      for (const binding of bindings) if (isRecord(input.body) && Object.hasOwn(input.body, binding.field)) {
        issue(['body', binding.field], 'Declare the local file only in files with field and file_path, not in body.');
      }
      const seen = new Set<string>();
      for (const [index, file] of (input.files ?? []).entries()) {
        if (!bindings.some(binding => binding.field === file.field)) issue(['files', index, 'field'], 'No declared file binding.');
        if (seen.has(file.field)) issue(['files', index, 'field'], 'Duplicate file operand.');
        seen.add(file.field);
      }
      for (const binding of bindings) if (binding.required && !seen.has(binding.field)) issue(['files'], 'A required file operand is missing.');
    });
    this.requests.set(op.operation_id, schema);
    return schema;
  }
  validateRequest(op: ApiOperation, input: unknown): ApiExecutionInput {
    const result = this.requestSchema(op).safeParse(input);
    if (!result.success) throw argumentFailure(executionIssues(result.error.issues));
    return result.data;
  }
  responseDescriptor(op: ApiOperation, status: number, media: string | null): ApiResponseDescriptor {
    const response = op.responses.find(candidate => candidate.status === status && candidate.media_type === media);
    if (!response) throw new ApiBoundaryError('INVALID_RESPONSE', 'The response status or media does not match a declared success response.', responseRepair);
    return response;
  }
  validateResponse(op: ApiOperation, status: number, media: string | null, data: unknown): ResponseContract {
    const response = this.responseDescriptor(op, status, media);
    if ((media === null && data !== null) || ((media === 'text/plain' || media === 'text/html') && typeof data !== 'string')) throw new ApiBoundaryError('INVALID_RESPONSE', 'The response data does not match its declared media.', responseRepair);
    if (response.schema === undefined) return 'matched';
    const validate = this.compile(op, this.responseRoot(op, op.responses.indexOf(response)));
    if (validate(ownData(data))) return 'matched';
    const paths = [...new Set(graphIssues(validate.errors, [], enumGuidance(this.catalog)).map(issue => issue.path.join('.')))].slice(0, 5);
    return { mismatch: wrapUntrusted(JSON.stringify({ message: 'Response data remains available, but the listed fields differ from the pinned schema. Check affected fields before relying on them; unaffected data remains usable. Report operation_id, status, content_type and response_contract to the connector maintainer or whoever manages your connector installation; keep raw data private. Do not blindly retry a mutation. Any pagination fields used by the connector are checked separately.', paths }), `elevenlabs:api:${op.operation_id}`)! };
  }
}
let validatorPromise: Promise<ApiValidator> | undefined;
export function loadApiValidator(): Promise<ApiValidator> {
  return validatorPromise ??= loadApiCatalog().then(catalog => new ApiValidator(catalog));
}
export async function validateRequest(profile: ApiProfile, input: unknown): Promise<ApiExecutionInput> {
  const envelope = executionInputSchema.safeParse(input);
  if (!envelope.success) throw argumentFailure(executionIssues(envelope.error.issues));
  const op = await getOperation(envelope.data.operation_id, profile);
  return (await loadApiValidator()).validateRequest(op, input);
}

const paginationSchemas = new WeakMap<ApiOperation, z.ZodType<{ has_more?: boolean; next_cursor?: string | null }>>();
export const NEXT_PAGE_INSTRUCTION = 'Pass data.next_cursor as query_params.cursor to the same operation.';
export function projectPagination(op: ApiOperation, data: unknown) {
  if (!op.pagination) return {};
  let schema = paginationSchemas.get(op);
  if (!schema) {
    const fields = paginationFieldsFor(op);
    schema = z.object({ has_more: fields.hasMoreRequired ? z.boolean() : z.boolean().optional(), next_cursor: fields.cursorRequired ? z.string().nullable() : z.string().nullable().optional() }).superRefine((value, ctx) => {
      if (value.has_more === true && !value.next_cursor) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['next_cursor'], message: 'A continuing page requires a cursor.' });
    });
    paginationSchemas.set(op, schema);
  }
  const checked = parseApiResponse(schema, ownData(data), 'API pagination');
  return { ...(checked.has_more === undefined ? {} : { has_more: checked.has_more }), ...(checked.next_cursor && checked.has_more !== false ? { next: NEXT_PAGE_INSTRUCTION } : {}) };
}

const envelopeText = z.string().regex(/^<untrusted-content source="elevenlabs:api:[a-zA-Z0-9_]+">[\s\S]*<\/untrusted-content>$/);
const responseContractSchema = z.union([z.literal('matched'), z.object({ mismatch: envelopeText }).strict()]);
function nextStepFor(followUps: readonly string[]): string {
  if (followUps.length === 1) {
    const [id] = followUps;
    return `Before using or attaching this result in any other call, read it with elevenlabs_read_resource using operation_id ${id} and the ID returned in data, then check the result.`;
  }
  return `Before using or attaching this result in any other call, read it with elevenlabs_read_resource using one of these operation_ids: ${followUps.join(', ')}; pass the ID returned in data to the one that takes an ID, then check the result.`;
}
export type ResponseContract = z.infer<typeof responseContractSchema>;
export const successReceiptSchema = z.object({
  ok: z.literal(true), operation_id: z.string().regex(/^[a-zA-Z0-9_]+$/), status: z.number().int().min(200).max(299),
  content_type: z.enum(['application/json', 'text/plain', 'text/html']).nullable(), data: envelopeText.nullable(),
  response_contract: responseContractSchema, has_more: z.boolean().optional(), next: z.literal(NEXT_PAGE_INSTRUCTION).optional(),
  follow_up_operations: z.array(z.string().regex(/^[a-zA-Z0-9_]+$/)).optional(), next_step: z.string().min(1).optional(), effects: effectsSchema, message: z.literal('The provider returned a success response.'),
}).strict().superRefine((value, ctx) => {
  const source = `elevenlabs:api:${value.operation_id}`;
  for (const [path, text] of [['data', value.data], ['response_contract', typeof value.response_contract === 'object' ? value.response_contract.mismatch : null]] as const) {
    if (text !== null && wrapUntrusted(text, source) !== text) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: 'Expected one intact operation envelope.' });
  }
  if ((value.content_type === null) !== (value.data === null)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['data'], message: 'Empty responses require null data.' });
  if (value.has_more === true && value.next === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['next'], message: 'A continuing page requires the static next instruction.' });
  const followUps = value.follow_up_operations ?? [];
  if (followUps.length > 0 && value.next_step !== nextStepFor(followUps)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['next_step'], message: 'The next-step instruction must match the static follow-up guidance.' });
  if (followUps.length === 0 && value.next_step !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['next_step'], message: 'The next-step instruction requires nonempty follow-up operations.' });
});
export async function createSuccessReceipt(operationId: string, status: number, media: string | null, parsedData: unknown) {
  const op = await getOperation(operationId);
  const validator = await loadApiValidator();
  const descriptor = validator.responseDescriptor(op, status, media);
  const response_contract = validator.validateResponse(op, status, descriptor.media_type, parsedData);
  const pagination = projectPagination(op, parsedData);
  const data = descriptor.media_type === null ? null : wrapUntrusted(descriptor.media_type === 'application/json' ? JSON.stringify(parsedData) : String(parsedData), `elevenlabs:api:${op.operation_id}`);
  return parseApiResponse(successReceiptSchema, { ok: true, operation_id: op.operation_id, status, content_type: descriptor.media_type,
    data, response_contract, ...pagination, follow_up_operations: op.follow_ups, ...(op.follow_ups.length > 0 ? { next_step: nextStepFor(op.follow_ups) } : {}), effects: op.effects, message: 'The provider returned a success response.' }, 'API receipt');
}

/** Connector-authored examples, checked against the same request refinement before discovery. */
export function examplesForOperation(op: ApiOperation): unknown[] {
  if (op.examples.length) return op.examples;
  switch (op.operation_id) {
    case 'create_agent_route': return [{ operation_id: op.operation_id, body: { name: 'Acme guide', conversation_config: {
      agent: { first_message: 'Hello. How can I help?', prompt: { llm: 'gemini-3.5-flash', prompt: 'Answer questions about the guide.', knowledge_base: [{ type: 'file', name: 'Guide', id: 'document_example' }] } }, tts: { voice_id: 'voice_example' },
    } } }];
    case 'patch_agent_settings_route': return [{ operation_id: op.operation_id, path_params: { agent_id: 'agent_example' }, body: { conversation_config: { agent: { first_message: 'Welcome.' } } } }];
    case 'add_tool_route': return [{ operation_id: op.operation_id, body: { tool_config: { type: 'webhook', name: 'lookup_guide', description: 'Look up guide entries.', api_schema: {
      url: 'https://api.example.com/guide', method: 'POST', request_body_schema: { type: 'object', properties: {
        llm_model: { type: 'string', description: 'A legitimate map key.' }, entries: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, enabled: { type: 'boolean', constant_value: true } } } },
      } },
    } }, response_mocks: [{ mock_result: '{"entries":[]}', parameter_conditions: [], is_error: false }] } }];
    case 'create_agent_response_test_route': return [{ operation_id: op.operation_id, body: { type: 'simulation', name: 'Guide mock test', simulation_scenario: 'Ask about the guide.', success_conditions: ['The agent answers using the guide.'], tool_mock_config: { mocking_strategy: 'all', fallback_strategy: 'raise_error' }, tool_mock_overrides: { tool_example: [{ mock_result: '{"entries":[]}', parameter_conditions: [], is_error: false }] } } }];
    case 'create_file_document_route': return [{ operation_id: op.operation_id, body: { name: 'Guide' }, files: [{ field: 'file', file_path: './guide.pdf' }] }];
    case 'update_file_document_route': return [{ operation_id: op.operation_id, path_params: { documentation_id: 'document_example' }, body: {}, files: [{ field: 'file', file_path: './guide.pdf' }] }];
    default: return [];
  }
}
