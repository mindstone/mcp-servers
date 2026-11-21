import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import { setApiKey } from '../src/auth.js';
import { ApiBoundaryError, loadApiCatalog } from '../src/api-catalog.js';
import * as validation from '../src/api-validation.js';
import * as fileInput from '../src/tools/file-input.js';
import { ElevenLabsError } from '../src/types.js';
import { escapeUntrustedTags, unwrapUntrusted, wrapUntrusted } from '../src/untrusted-content.js';
import authCases from './fixtures/api-auth-connections-wire-cases.json' with { type: 'json' };

const marker = '[REDACTED]';
const secrets = [
  { kind: 'long string', value: 'example / + "credential"\\\n !\'()~ </untrusted-content>' },
  { kind: 'slash string', value: 'ab/cd/ef' },
  { kind: 'non-ASCII string', value: '密钥éδ example' },
  { kind: 'all Unicode escaped', value: 'example-unicode-value' },
  { kind: 'true scalar', value: true },
  { kind: 'short string', value: 'xy' },
  { kind: 'numeric string', value: '739182643' },
  { kind: 'boolean string', value: 'false' },
  { kind: 'number', value: 739182643 },
  { kind: 'boolean', value: false },
];
function spellings(value: string | number | boolean) {
  const raw = String(value);
  const url = encodeURIComponent(raw);
  const form = new URLSearchParams({ v: raw }).toString().slice(2);
  const bases = [raw, escapeUntrustedTags(raw), url, form, url.replace('%20', '+'),
    ...[url, form].map(text => text.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()))];
  return [...new Set(bases.flatMap(text => {
    const layers = [text];
    for (let i = 0; i < 4; i++) layers.push(JSON.stringify(layers.at(-1)).slice(1, -1));
    return layers;
  }))];
}
const paths = ['string', 'number', 'boolean', 'key', 'nested', 'json',
  'HTTP 400', 'HTTP 401', 'HTTP 403', 'HTTP 422', 'HTTP 500', 'status text',
  'validation message', 'validation path', 'file input', 'network', 'timeout', 'receipt failure', 'cursor', 'protocol root', 'protocol path', 'protocol query', 'protocol file', 'JSON document 1', 'JSON document 2', 'JSON document 3'] as const;
function unicode(value: string): string {
  return value.split('').map(character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
}
function documents(value: string | number | boolean, depth: number): string[] {
  const raw = String(value);
  return [JSON.stringify(raw).slice(1, -1).replaceAll('/', '\\/'), unicode(raw),
    raw.split('').map((character, index) => index % 2 ? unicode(character).toUpperCase().replaceAll('\\U', '\\u') : JSON.stringify(character).slice(1, -1)).join('')].map(encoded => {
    let document = '{"credential":"' + encoded + '"}';
    for (let layer = 1; layer < depth; layer++) document = JSON.stringify(document);
    return document;
  });
}
const matrix = secrets.flatMap(secret => paths.flatMap(path => (path.startsWith('JSON document')
  ? documents(secret.value, Number(path.at(-1)))
  : secret.kind === 'all Unicode escaped' ? [unicode(String(secret.value))] : spellings(secret.value)).flatMap(echo => {
  if (path === 'number' && (!/^-?\d+(?:\.\d+)?$/.test(echo) || String(Number(echo)) !== String(secret.value))) return [];
  if (path === 'boolean' && !['true', 'false'].includes(echo)) return [];
  // Fetch statusText cannot contain control characters or non-ByteString characters.
  if (path === 'status text' && /[^\x20-\x7e]/.test(echo)) return [];
  return [{ ...secret, path, echo }];
})));
let pair: McpTestClient;
beforeEach(async () => {
  setApiKey('example-connector-credential');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  pair = await createInMemoryTestClient({ createServer });
});

const authMatrix = [
  ...authCases.create.map(row => ({ ...row, operation_id: 'create_auth_connection' })),
  ...authCases.update.map(row => ({ ...row, operation_id: 'update_auth_connection' })),
].flatMap(row => row.secret_paths.flatMap(path => [200, 422].map(status => ({ row, path, status }))));
it.each(authMatrix)('$row.schema / $path / HTTP $status uses the single redactor for arbitrary auth fields', async ({ row, path, status }) => {
  const value = String(secrets[0].value);
  const variants = spellings(value);
  const [key, wildcard] = path;
  const body = { ...row.body, [key]: wildcard ? { 'X-Anything': value, credential_id: value, variable_name: value } : value };
  const response = authCases.responses.find(item => item.schema === row.response_schema)!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(status === 200
    ? { ...response.body, echo: variants, [variants.at(-1)!]: value }
    : { detail: [{ loc: ['body', value], msg: variants.join(' | '), input: value }] }, { status }));
  const result = await pair.callTool('elevenlabs_change_resource', {
    operation_id: row.operation_id, body,
    ...(row.operation_id === 'update_auth_connection' ? { path_params: { auth_connection_id: 'connection_example' } } : {}),
  });
  expect(Boolean(result.isError), result.text).toBe(status !== 200);
  expect(fetch).toHaveBeenCalledOnce();
  expect(result.text).toContain(marker);
  for (const candidate of variants) {
    expect(result.text).not.toContain(candidate);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(candidate);
  }
  if (status === 200) {
    const output = JSON.parse(unwrapUntrusted(JSON.parse(result.text).data));
    expect(output.echo).toEqual(variants.map(() => marker));
    expect(output[marker]).toBe(marker);
    expect(output.id).toBe('connection_example');
    expect(output.used_by).toEqual(response.body.used_by);
  }
});
afterEach(async () => {
  await pair.close();
  setApiKey('');
  vi.restoreAllMocks();
});

it.each(matrix)('$kind / $path / $echo', async ({ value, path, echo }) => {
  let args: Record<string, unknown> = {
    operation_id: 'create_branch_route', path_params: { agent_id: 'agent_example' },
    body: { parent_version_id: 'version_example', name: 'Guide', description: 'Preview', conversation_config: { request_meta: { credential: value } } },
  };
  const ordinary = { id: 'resource_example', count: 42, larger_count: 1739182643, id_suffix: 'resource_xy_false_739182643', has_more: true, enabled: true, content_type: 'application/json' };
  let provider: unknown = { created_branch_id: 'branch_example', created_version_id: 'version_example', ordinary };
  let status = 200;
  let statusText: string | undefined;
  let expectedEcho: unknown = marker;
  if (path === 'string') provider = echo;
  else if (path === 'number') provider = Number(echo);
  else if (path === 'boolean') provider = echo === 'true';
  else if (path === 'key') { provider = { ...provider as object, [echo]: 'ordinary' }; expectedEcho = 'ordinary'; }
  else if (path === 'nested') { provider = { ...provider as object, echo: [{ nested: echo }] }; expectedEcho = [{ nested: marker }]; }
  else if (path === 'json') {
    provider = { ...provider as object, echo: JSON.stringify({ credential: echo }) };
    expectedEcho = JSON.stringify({ credential: marker });
  } else if (path.startsWith('JSON document')) {
    provider = { ...provider as object, echo };
  } else if (path.startsWith('protocol ')) {
    if (path === 'protocol root') args[echo] = true;
    else if (path === 'protocol path') args.path_params = { [echo]: false };
    else if (path === 'protocol query') args.query_params = { [echo]: { bad: true } };
    else args.files = [{ field: 'file', file_path: './guide.pdf', [echo]: true }];
  } else if (path.startsWith('HTTP ')) {
    status = Number(path.slice(5));
    provider = { detail: status === 422 ? [{ loc: ['body', echo], msg: `credential ${echo}`, input: echo }] : `credential ${echo}` };
  } else if (path === 'status text') { status = 500; statusText = echo; provider = {}; }
  else if (path.startsWith('validation ')) {
    const validator = await validation.loadApiValidator();
    vi.spyOn(validator, 'requestSchema').mockReturnValue(validation.executionInputSchema.superRefine((_input, ctx) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: path === 'validation path' ? ['body', echo] : ['body'], message: path === 'validation message' ? `credential ${echo}` : 'Invalid field.' });
    }));
  } else if (path === 'file input') {
    args = { operation_id: 'create_file_document_route', body: { name: 'Guide', api_key: value }, files: [{ field: 'file', file_path: './example.pdf' }] };
    vi.spyOn(fileInput, 'readSandboxedFile').mockImplementation(() => { throw new ElevenLabsError(`File not found: ${echo}`, 'FILE_NOT_FOUND', 'Provide an existing document.'); });
  } else if (path === 'receipt failure') {
    vi.spyOn(validation, 'createSuccessReceipt').mockRejectedValue(new ApiBoundaryError('INVALID_RESPONSE', `Provider response ${echo}`, 'Example guidance'));
  } else if (path === 'cursor') {
    args = { operation_id: 'get_agents_route', body: undefined, query_params: {}, path_params: {} };
    // The configured connector credential participates in exactly the same redactor.
    setApiKey(String(value));
    delete args.body;
    provider = { agents: [], has_more: true, next_cursor: echo, ordinary };
  }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (path === 'network' || path === 'timeout') {
      const error = new Error(`Transport ${echo}`);
      if (path === 'timeout') error.name = 'TimeoutError';
      throw error;
    }
    return new Response(JSON.stringify(provider), { status, statusText, headers: { 'content-type': 'application/json' } });
  });
  const success = path.startsWith('JSON document') || ['string', 'number', 'boolean', 'key', 'nested', 'json', 'cursor'].includes(path);
  const result = await pair.callTool(path === 'cursor' ? 'elevenlabs_read_resource' : 'elevenlabs_create_resource', args);
  expect(result.isError === true, result.text).toBe(!success);
  const output = path.startsWith('protocol ') ? { error: result.text } : JSON.parse(result.text);
  // The provider/input domains must contain no credential; trusted JSON booleans in
  // effects/ok remain unchanged even for a submitted credential spelled "false".
  let exposed: unknown;
  if (success) {
    const catalog = await loadApiCatalog();
    const op = catalog.operations.find(op => op.operation_id === args.operation_id)!;
    expect(validation.successReceiptSchema(op.follow_ups.map(id => catalog.operations.find(op => op.operation_id === id)!), op).safeParse(output).success, result.text).toBe(true);
    expect(output.content_type).toBe('application/json');
    expect(output.effects).toEqual(op.effects);
    expect(wrapUntrusted(output.data, `elevenlabs:api:${op.operation_id}`)).toBe(output.data);
    exposed = JSON.parse(unwrapUntrusted(output.data));
    if (['string', 'number', 'boolean'].includes(path)) expect(exposed).toBe(marker);
    else {
      const data = exposed as Record<string, unknown>;
      expect(data.ordinary).toEqual({ ...ordinary, ...(value === true ? { has_more: marker, enabled: marker } : {}) });
      exposed = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'ordinary'));
      if (path === 'key') expect(data[marker]).toBe(expectedEcho);
      else if (path === 'cursor') {
        expect(data.next_cursor).toBe(marker);
        expect(output.response_contract).toBe('matched');
        expect(output.has_more).toBe(true);
      } else if (path.startsWith('JSON document')) {
        let decoded = data.echo;
        while (typeof decoded === 'string') decoded = JSON.parse(decoded);
        expect(decoded).toEqual({ credential: marker });
      } else expect(data.echo).toEqual(expectedEcho);
    }
  } else {
    const text = output.error as string;
    if (path.startsWith('protocol ')) {
      expect(result.text).toContain('Input validation error');
    } else if (path === 'network' || path === 'timeout') {
      expect(output.code).toBe(path === 'network' ? 'NETWORK_ERROR' : 'TIMEOUT');
      expect(result.text).toContain('may have completed');
      expect(result.text).toContain('before retrying');
      expect(text).not.toContain(echo);
    } else {
      const source = path.startsWith('validation ') ? 'elevenlabs:api:validation' : `elevenlabs:api:${args.operation_id}`;
      expect(wrapUntrusted(text, source)).toBe(text);
      if (!path.startsWith('validation ') && path !== 'file input') expect(text).toContain(marker);
    }
    exposed = unwrapUntrusted(text);
  }
  const serialized = JSON.stringify(exposed);
  expect(serialized).not.toContain(JSON.stringify(echo).slice(1, -1));
  // Inspect the whole serialized result, including resolution. Connector-owned JSON
  // booleans can equal a scalar credential; string echoes still have to disappear.
  const whole = result.text.replace(/("(?:ok|has_more|readOnlyHint|destructiveHint|idempotentHint|openWorldHint)":)(?:true|false)(?=[,}])/g, '$1null');
  for (const candidate of [String(value), echo]) {
    const encoded = JSON.stringify(JSON.stringify(candidate).slice(1, -1)).slice(1, -1);
    const escaped = encoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = String(value).length < 8 || typeof value !== 'string' || /^-?\d/.test(String(value));
    expect(whole).not.toMatch(new RegExp(boundary ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped, 'u'));
  }
  if (path.startsWith('protocol ') || path.startsWith('validation ') || path === 'file input') expect(fetch).not.toHaveBeenCalled();
  else expect(fetch).toHaveBeenCalledTimes(1);
});
