import { createRedactor } from '../src/api-sensitive.js';
import { describe, expect, it } from 'vitest';
import { apiCatalog as generated } from '../src/generated/api-catalog.js';
import {
  API_TOOLS, describeOperation, discoverOperations, expandSchema, getOperation,
  ApiBoundaryError, loadApiCatalog, validateApiCatalog, reachableDefinitions, type ApiCatalog,
} from '../src/api-catalog.js';
import { validateRequest } from '../src/api-validation.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';

describe('strict catalogue metadata and reference integrity', () => {
  it('checks the actual generated shape and shares the cached immutable catalogue', async () => {
    const catalog = await loadApiCatalog();
    expect(await loadApiCatalog()).toBe(catalog);
    expect(catalog.operations).toHaveLength(373);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(await getOperation('get_agent_route')).toBe(await getOperation('get_agent_route'));
    expect(Object.values(API_TOOLS)).toEqual([
      'elevenlabs_discover_api', 'elevenlabs_read_resource', 'elevenlabs_create_resource',
      'elevenlabs_change_resource', 'elevenlabs_delete_resource', 'elevenlabs_run_agent_tests', 'elevenlabs_query_knowledge', 'elevenlabs_run_job', 'elevenlabs_place_call',
    ]);
  });

  it.each([
    ['unknown metadata', (catalog: ApiCatalog) => Object.assign(catalog, { surprise: true })],
    ['coercion enabled', (catalog: ApiCatalog) => Object.assign(catalog.validator_options, { coerceTypes: true })],
    ['unreviewed keyword', (catalog: ApiCatalog) => catalog.schema_metadata_keywords.push('new-keyword')],
    ['duplicate operation', (catalog: ApiCatalog) => catalog.operations.push(catalog.operations[0])],
    ['wrong tool', (catalog: ApiCatalog) => { catalog.operations[0].tool = 'invented_tool'; }],
    ['wrong effects', (catalog: ApiCatalog) => { catalog.operations[0].effects.readOnlyHint = true; }],
    ['missing root ref', (catalog: ApiCatalog) => { catalog.operations[0].request.schema = { $ref: '#/$defs/missing' }; }],
    ['inherited component ref', (catalog: ApiCatalog) => { catalog.operations[0].request.schema = { $ref: '#/$defs/toString' }; }],
    ['external ref', (catalog: ApiCatalog) => { catalog.operations[0].request.schema = { $ref: 'https://example.com/schema' }; }],
    ['missing discriminator ref', (catalog: ApiCatalog) => { catalog.operations[0].request.schema = { discriminator: { propertyName: 'type', mapping: { example: '#/$defs/missing' } } }; }],
    ['missing follow-up', (catalog: ApiCatalog) => { catalog.operations[0].follow_ups = ['missing']; }],
    ['alias anchor changed', (catalog: ApiCatalog) => { Object.assign(catalog.compatibility_overlay.forbidden_aliases[0], { prompt_path: ['body', 'prompt'] }); }],
    ['schema keyword in schema position', (catalog: ApiCatalog) => { catalog.operations[0].request.schema = { type: 'object', properties: { field: { unknownKeyword: true } } }; }],
    ['unbound path', (catalog: ApiCatalog) => { catalog.operations[0].path = '/v1/convai/tools/{missing}'; }],
  ])('fails closed for %s', (_name, mutate) => {
    const catalog = structuredClone(generated) as ApiCatalog;
    mutate(catalog);
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it('walks schema positions while retaining arbitrary enum/example data and map keys', () => {
    const catalog = structuredClone(generated) as ApiCatalog;
    catalog.operations[0].request.schema = { type: 'object', properties: {
      format: { type: 'string' }, properties: { type: 'object', additionalProperties: true },
    }, example: { $ref: '#/$defs/not-a-schema-ref', unknownKeyword: true }, enum: [{ $ref: 'data', properties: { anything: true } }] };
    expect(validateApiCatalog(catalog).operations[0].request.schema).toEqual(catalog.operations[0].request.schema);
    expect(Object.isFrozen(catalog.operations[0].request.schema)).toBe(false);
  });
});

describe('discovery', () => {
  it('discloses only reachable schemas, retaining cycles and discriminator mappings', async () => {
    const catalog = structuredClone(await loadApiCatalog());
    const op = catalog.operations.find(op => op.operation_id === 'get_test_invocation_route')!;
    const before = reachableDefinitions(op, catalog);
    catalog.$defs.Unrelated = { type: 'string' };
    expect(reachableDefinitions(op, catalog)).toEqual(before);
    catalog.$defs.Cycle = { $ref: '#/$defs/Cycle', discriminator: { propertyName: 'kind', mapping: { branch: '#/$defs/Branch' } } };
    catalog.$defs.Branch = { type: 'object', properties: { back: { $ref: '#/$defs/Cycle' } } };
    op.request.schema = { $ref: '#/$defs/Cycle', example: { $ref: '#/$defs/Unrelated' } };
    expect(reachableDefinitions(op, catalog)).toEqual([...before, 'Branch', 'Cycle'].sort());
    const described = JSON.parse(unwrapUntrusted((await describeOperation(op.operation_id)).contract));
    expect(described.definitions).toEqual(before);
    const explicit = JSON.parse(unwrapUntrusted((await describeOperation(op.operation_id, 'KnowledgeBaseLocator')).contract));
    expect(explicit.definition.name).toBe('KnowledgeBaseLocator');
  });

  it('keeps the complete inventory reachable through paginated discovery', async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await discoverOperations({ limit: 25, cursor });
      if (!('operations' in page)) throw new Error('Expected discovery page');
      ids.push(...page.operations.map(op => op.operation_id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(ids.sort()).toEqual((await loadApiCatalog()).operations.map(op => op.operation_id).sort());
  });
  it.each([
    ['tests', 'run_agent_test_suite_route'],
    ['knowledge', 'query_agent_knowledge_base_rag_route'],
  ])('finds profile-specific operations in the %s family', async (family, operation_id) => {
    const operations = [];
    let cursor: string | undefined;
    do {
      const result = await discoverOperations({ family, limit: 25, cursor });
      expect(result).toHaveProperty('operations');
      if (!('operations' in result)) throw new Error('Expected a discovery listing.');
      operations.push(...result.operations);
      cursor = result.next_cursor ?? undefined;
    } while (cursor);
    expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({ operation_id, family })]));
  });

  it('keeps connector-written navigation references tied to actual tools, operations and the snapshot date', async () => {
    const catalog = await loadApiCatalog();
    const tools = new Set<string>([...Object.values(API_TOOLS), 'list_voices']);
    const ids = new Set(catalog.operations.map(op => op.operation_id));
    for (const op of catalog.operations) {
      const description = await describeOperation(op.operation_id);
      const contract = JSON.parse(unwrapUntrusted(description.contract));
      expect(description.instructions).toContain('Operation IDs listed here or in receipts are names only.');
      expect(description.instructions).toContain('Before the first call to each operation in this conversation, call elevenlabs_discover_api with that operation_id to read its contract');
      expect(description.instructions).toContain('unless a tool description or receipt already supplies the exact parameter names and locations.');
      expect(description.instructions).toContain('Never infer path_params, query_params or body fields from an operation name.');
      for (const token of description.instructions.match(/elevenlabs_[a-z_]+|list_voices/g) ?? []) expect(tools.has(token), token).toBe(true);
      for (const match of description.instructions.matchAll(/operation_id:"([a-z_]+)"/g)) expect(ids.has(match[1]), match[1]).toBe(true);
      const exampleId = description.instructions.match(/EXAMPLE: elevenlabs_discover_api\(\{operation_id:"([a-z_]+)"\}/)![1];
      const example = await getOperation(exampleId);
      for (const [, location, name] of description.instructions.matchAll(/\b(path_params|query_params)\.([a-z_]+)\b/g)) {
        const target = op.manual_pagination?.includes(`${location}.${name}`) ? op : example;
        const schema = location === 'path_params' ? target.parameters.path : target.parameters.query;
        expect(typeof schema === 'object' && schema.properties, `${target.operation_id}: ${location}.${name}`).toHaveProperty(name);
      }
      expect(contract.validation.snapshot_date).toBe(catalog.compatibility_overlay.enum_snapshot_date);
    }
  });

  it('matches a word and its plural, both ways', async () => {
    const ids = async (query: string) => (await discoverOperations({ query, family: 'agents', limit: 25 })).operations.map(op => op.operation_id);
    expect((await ids('agent summary'))[0]).toBe('get_agent_summaries_route');
    expect((await ids('agents summaries'))[0]).toBe('get_agent_summaries_route');
    expect(await discoverOperations({ query: 'statuses', limit: 25 })).toEqual(await discoverOperations({ query: 'status', limit: 25 }));
  });

  it('uses token overlap, stable ID ties, and offset pagination', async () => {
    const first = await discoverOperations({ query: 'webhook', family: 'tools', limit: 2 });
    expect(first).toMatchObject({ operations: [{ operation_id: 'add_tool_route' }, { operation_id: 'delete_tool_route' }], next_cursor: '2', total: 6 });
    const second = await discoverOperations({ query: 'webhook', family: 'tools', limit: 2, cursor: '2' });
    expect(second).toMatchObject({ operations: [{ operation_id: 'get_tool_dependent_agents_route' }, { operation_id: 'get_tool_route' }], next_cursor: '4', total: 6 });
    expect(await discoverOperations({ query: 'webhook', family: 'tools', limit: 2 })).toEqual(first);
    expect(await discoverOperations({ query: 'webhook', family: 'tools', cursor: '6' })).toMatchObject({ operations: [], next_cursor: null, total: 6 });
    expect(await discoverOperations({ query: 'zzzzzzzz_unfindable' })).toMatchObject({ operations: [], total: 0 });
  });

  it.each([{ limit: 0 }, { limit: 26 }, { limit: 1.5 }, { limit: '2' }, { cursor: '-1' }, { cursor: '1e2' }, { cursor: '9007199254740992' }, { family: 'unknown' }, { extra: true }, { definition: 'LLM' }])('rejects invalid discovery input %j', async input => {
    await expect(discoverOperations(input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('gives actionable discovery navigation and safe field issues', async () => {
    try {
      await discoverOperations({ family: 'private-value', definition: 'LLM' });
      throw new Error('Expected invalid discovery input.');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiBoundaryError);
      const failure = error as ApiBoundaryError;
      expect(failure.issues).toContainEqual({ path: ['family'], keyword: 'invalid_enum_value', message: 'Allowed values: agents, tools, knowledge, tests, analysis-items, analytics, assets, audio-effects, audio-isolation, audio-native, batch-calling, conversation, conversations, dubbing, environment-variables, environments, exotel, forced-alignment, history, llm-usage, mcp-servers, models, music, phone-numbers, pronunciation-dictionaries, realtime, secrets, settings, shared-voices, similar-voices, single-use-token, sip-trunk, sound-generation, speech-engine, speech-to-text, studio, tags, text-to-dialogue, text-to-speech, text-to-voice, triage-tickets, twilio, usage, user, users, v2/phone-numbers, voice-changer, voices, voices-v2, whatsapp, whatsapp-accounts.' });
      expect(failure.resolution).toContain('elevenlabs_discover_api({query:"agents"})');
      expect(failure.resolution).toContain("previous discovery result's next_cursor");
      expect(failure.resolution).toContain('Replace create_agent_route in both examples with the operation_id you intend to use.');
      expect(JSON.stringify(failure.toJSON())).not.toContain('private-value');
    }
    await expect(discoverOperations({ definition: 'LLM' })).rejects.toMatchObject({ issues: [{ path: ['definition'], message: 'definition requires operation_id.' }] });
    await expect(discoverOperations({ operation_id: 'create_agent_route', definition: '#/$defs/KnowledgeBaseLocator' })).rejects.toMatchObject({ code: 'UNKNOWN_DEFINITION', resolution: expect.stringContaining('definition:"KnowledgeBaseLocator"') });
    const description = await discoverOperations({ operation_id: 'create_agent_route', definition: 'KnowledgeBaseLocator' });
    expect(JSON.parse(unwrapUntrusted(description.contract)).definition.name).toBe('KnowledgeBaseLocator');
  });

  it('shows two reference levels, retained named refs, dated enums and valid structured examples', async () => {
    const result = await describeOperation('create_agent_route');
    const contract = JSON.parse(unwrapUntrusted(result.contract));
    expect(contract.request.body.properties.conversation_config.allOf[0].properties.agent).toEqual(expect.objectContaining({ $ref: '#/$defs/AgentConfigAPIModel-Input' }));
    expect(contract.definitions).toContain('KnowledgeBaseLocator');
    expect(contract.validation.snapshot_date).toBe('2026-11-08');
    expect(contract.validation.enums).toMatch(/enum.*2026-11-08.*refresh/i);
    expect(contract.validation.enums).toContain('connector maintainer');
    expect(contract.validation.enums).toContain('whoever manages your connector installation');
    expect(contract.validation.forbidden_aliases).toEqual((await loadApiCatalog()).compatibility_overlay.forbidden_aliases);
    expect(contract.validation.alias_guidance).toMatch(/prompt paths.*llm.*KnowledgeBaseLocator.*data keys elsewhere.*does not rename/);
    expect(contract.example_notes.join(' ')).toContain('Replace *_example IDs');
    expect(result.instructions).toContain('elevenlabs_discover_api({operation_id:"create_agent_route"})');
    expect(contract.examples[0].body.conversation_config.agent.prompt).toMatchObject({ llm: 'gemini-3.5-flash', knowledge_base: [{ type: 'file', name: 'Guide', id: 'document_example' }] });
    for (const example of contract.examples) await expect(validateRequest('create', example, createRedactor([]))).resolves.toBeDefined();
    expect(result).not.toHaveProperty('summary');
    expect(result).not.toHaveProperty('description');
  });

  it('returns a named recursive definition and deterministically refuses missing names and IDs', async () => {
    const described = await describeOperation('add_tool_route', 'ObjectJsonSchemaProperty-Input');
    const contract = JSON.parse(unwrapUntrusted(described.contract));
    expect(contract.definition.name).toBe('ObjectJsonSchemaProperty-Input');
    expect(JSON.stringify(contract.definition.schema)).toContain('#/$defs/ObjectJsonSchemaProperty-Input');
    await expect(describeOperation('missing')).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' });
    await expect(describeOperation('get_agent_route', 'toString')).rejects.toMatchObject({ code: 'UNKNOWN_DEFINITION' });
  });

  it('validates concise webhook, explicit safe-mock, and file-operand examples locally', async () => {
    for (const id of ['add_tool_route', 'create_agent_response_test_route', 'create_file_document_route', 'update_file_document_route']) {
      const result = await describeOperation(id);
      const contract = JSON.parse(unwrapUntrusted(result.contract));
      expect(contract.examples).toHaveLength(1);
      for (const example of contract.examples) await expect(validateRequest(result.profile, example, createRedactor([]))).resolves.toBeDefined();
      if (id === 'create_agent_response_test_route') {
        expect(contract.examples[0].body.tool_mock_config).toEqual({ mocking_strategy: 'all', fallback_strategy: 'raise_error' });
        expect(contract.example_notes.join(' ')).toMatch(/configured tool results instead of real tool calls.*tool_mock_config.*tool_mock_overrides.*does not itself configure mocks/);
      }
      if (id.includes('file_document')) {
        expect(contract.examples[0].files).toEqual([{ field: 'file', file_path: './guide.pdf' }]);
        expect(contract.example_notes.join(' ')).toMatch(/connector's machine.*connector's working directory/);
      }
    }
    const read = JSON.parse(unwrapUntrusted((await describeOperation('get_agent_route')).contract));
    expect(read.request).not.toHaveProperty('files');
  });

  it('points to admitted reads for checking saved Tests and explicit mocks before running', async () => {
    const run = await describeOperation('run_agent_test_suite_route');
    expect(run.instructions).toMatch(/Before running.*saved Test.*target agent.*referenced tools.*external actions/);
    expect(run.instructions).toContain('tool_mock_config, tool_mock_overrides and fallback behavior where supported');
    expect(run.instructions).toContain('running a saved Test does not itself configure mocks');
    for (const operationId of ['get_agent_response_test_route', 'get_agent_route', 'get_tool_route']) {
      expect(run.instructions).toContain(operationId);
      expect(await getOperation(operationId, 'read')).toMatchObject({ profile: 'read', tool: 'elevenlabs_read_resource' });
    }
  });

  it('retains example data and treats __proto__ map keys as data during expansion', () => {
    const catalog = validateApiCatalog(structuredClone(generated));
    const example = { description: '</UNTRUSTED-CONTENT >example', $ref: 'data' };
    const expanded = expandSchema({ type: 'object', example, properties: JSON.parse('{"__proto__":{"type":"string"}}') }, catalog);
    expect(expanded).toMatchObject({ example });
    expect(Object.hasOwn((expanded as Record<string, unknown>).properties, '__proto__')).toBe(true);
    expect(Object.prototype).not.toHaveProperty('type');
  });
});
