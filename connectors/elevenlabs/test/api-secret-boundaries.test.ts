import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from '../src/server.js';
import { setApiKey } from '../src/auth.js';
import { createRedactor, sensitiveValues } from '../src/api-sensitive.js';
import * as catalogModule from '../src/api-catalog.js';
import { getOperation, loadApiCatalog, type ApiOperation } from '../src/api-catalog.js';
import { executeApiOperation } from '../src/api-executor.js';
import { createSuccessReceipt, loadApiValidator } from '../src/api-validation.js';
import { elevenLabsFetch } from '../src/client.js';
import { matchesFieldPath } from '../src/api-field-paths.mjs';
import { isCredentialKey } from '../src/api-credential-keys.mjs';
import { unwrapUntrusted, wrapUntrusted } from '../src/untrusted-content.js';
import { classifyParameters, compileCatalog, loadCoverageRosters, PINNED_SOURCE, credentialRequestPaths } from '../scripts/generate-api-catalog.mjs';
import policy from '../api/operation-policy.json' with { type: 'json' };
import lifecycle from './fixtures/api-agent-lifecycle-wire-cases.json' with { type: 'json' };
import assets from './fixtures/api-assets-wire-cases.json' with { type: 'json' };
import flows from './fixtures/api-flows-wire-cases.json' with { type: 'json' };
import studio from './fixtures/api-studio-wire-cases.json' with { type: 'json' };
import templates from './fixtures/api-templates-wire-cases.json' with { type: 'json' };
import storedHeaders from './fixtures/api-stored-header-paths.json' with { type: 'json' };
import { mswServer } from './helpers/setup.js';
import { ElevenLabsError } from '../src/types.js';
import { withErrorHandling } from '../src/utils.js';

const key = 'synthetic-account-key/+/123456789';
const secret = 'synthetic-stored-credential/+/123456789';
const rawSource = 'synthetic-raw-wrapper-marker';
const statuses = [200, 400, 401, 403, 422, 500];
const escapes = (value: string) => [value, encodeURIComponent(value), encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, value => value.toLowerCase()),
  JSON.stringify(value).slice(1, -1).replace(/\//g, '\\/'), [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')];
const tool = (op: ApiOperation) => op.tool;
const payload = (result: { text: string }) => JSON.parse(unwrapUntrusted(JSON.parse(result.text).data));
let pair: McpTestClient;
let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'secret-boundaries-'));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  setApiKey(key);
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => {
  await pair.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setApiKey('');
  await rm(workspace, { recursive: true, force: true });
});

function plant(path: readonly string[], value: unknown): Record<string, unknown> {
  const [field, ...rest] = path;
  return { [field === '*' ? 'example' : field]: rest.length ? plant(rest, value) : value };
}
const transferTool = (headers: unknown[]) => ({ type: 'system', name: 'transfer_to_number', params: {
  system_tool_type: 'transfer_to_number', transfers: [{ transfer_destination: { type: 'sip_uri', sip_uri: 'sip:guide@example.com' },
    condition: 'when asked', custom_sip_headers: headers }],
} });
const toolReply = (config: unknown) => ({ id: 'tool_example', access_info: { is_creator: true, creator_name: 'Jane Example', creator_email: 'jane@example.com', role: 'admin' },
  usage_stats: { avg_latency_secs: 0 }, tool_config: config });

it.each(['path', 'query', 'header'])('refuses generation for unclassified credential-like %s names and descriptions', location => {
  for (const parameter of [
    ...['token', 'signature', 'secret', 'key', 'password', 'credential', 'auth', 'apiKey', 'accessToken', 'signedValue', 'expiringValue'].map(name => ({ in: location, name })),
    ...['An expiring value', 'A signed value', 'Authentication material', 'A signature for this request'].map(description => ({ in: location, name: 'opaque', description })),
  ]) {
    expect(() => classifyParameters([parameter], [], 'example')).toThrow('unclassified credential-like parameter');
    const classification = { in: location, name: parameter.name, secret: true, reason: 'Authentication material.' };
    expect(classifyParameters([parameter], [classification], 'example')).toEqual([classification]);
  }
});

it.skipIf(!process.env.ELEVENLABS_OPENAPI_SPEC)('enforces the parameter census while compiling the pin, including a description-only future credential', async () => {
  const bytes = await readFile(process.env.ELEVENLABS_OPENAPI_SPEC!);
  const rosters = await loadCoverageRosters(resolve(import.meta.dirname, '..'));
  for (const classification of policy.parameter_credentials) {
    const changed = structuredClone(policy);
    changed.parameter_credentials = changed.parameter_credentials.filter(row => row.in !== classification.in || row.name !== classification.name);
    expect(() => compileCatalog(bytes, changed, PINNED_SOURCE, rosters)).toThrow('unclassified credential-like parameter');
  }
  const compiled = compileCatalog(bytes, policy, PINNED_SOURCE, rosters);
  expect(compiled).toEqual(await loadApiCatalog());
  const catalog = await loadApiCatalog();
  for (const op of catalog.operations) for (const classification of op.parameter_credentials ?? []) {
    expect(policy.parameter_credentials).toContainEqual(classification);
  }
});

it.each(statuses)('contains signature query echoes at HTTP %s with one dispatch', async status => {
  const row = lifecycle.find(row => row.id === 'get_agent_widget_route')!;
  const op = await getOperation(row.id);
  const spellings = escapes(secret);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    expect(new URL(String(url)).searchParams.get('conversation_signature')).toBe(secret);
    return Response.json(status === 200 ? { ...row.response, widget_config: { ...row.response!.widget_config, first_message: spellings.join(' ') } } : { detail: spellings.join(' ') }, { status });
  });
  const result = await pair.callTool(tool(op), { operation_id: op.operation_id, ...row.args, query_params: { conversation_signature: secret } });
  expect(Boolean(result.isError)).toBe(status !== 200);
  if (status === 200) expect(result.json).toMatchObject({ response_contract: 'matched' });
  for (const spelling of spellings) expect(result.text).not.toContain(spelling);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['path', 'query'] as const)('collects both raw and normalized wrapped %s credentials, including JSON escapes', async location => {
  const wrapped = wrapUntrusted(secret, rawSource)!;
  const op = structuredClone(await getOperation(location === 'path' ? 'get_secret_route' : 'speech_to_text'));
  const get = catalogModule.getOperation;
  vi.spyOn(catalogModule, 'getOperation').mockImplementation(async (id, profile) => id === op.operation_id ? op : get(id, profile));
  // The current pin has no credential-valued path. Model a future classified path at this shared seam.
  if (location === 'path') op.parameter_credentials = [{ in: 'path', name: 'secret_id', secret: true, reason: 'Synthetic credential-valued path regression.' }];
  const spellings = [...escapes(secret), ...escapes(wrapped)];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    expect(location === 'query' ? new URL(String(url)).searchParams.get('token') : decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1)!)).toBe(secret);
    return Response.json(location === 'query' ? { language_code: 'en', language_probability: 1, text: spellings.join(' '), words: [] } : { diagnostic: spellings.join(' ') });
  });
  try {
    const result = await pair.callTool(tool(op), { operation_id: op.operation_id, ...(location === 'query'
      ? { query_params: { token: wrapped }, body: { model_id: 'scribe_v2', cloud_storage_url: 'https://example.com/clip.mp3' } }
      : { path_params: { secret_id: wrapped } }) });
    expect(result.isError, result.text).not.toBe(true);
    for (const spelling of spellings) expect(result.text).not.toContain(spelling);
    expect(result.text).not.toContain(rawSource);
    expect(fetch).toHaveBeenCalledOnce();
  } finally { vi.restoreAllMocks(); }
});

it('treats continuation operands as identifiers, preserving zero metadata', async () => {
  for (const name of ['page_token', 'cursor', 'next_cursor', 'next_page_token', 'continuation_token', 'last_history_item_id', 'start_after_history_item_id']) {
    expect(isCredentialKey(name), name).toBe(false);
    expect(sensitiveValues({ [name]: '0' }, []), name).toEqual([]);
  }
  expect(isCredentialKey('token')).toBe(true);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ voices: [], has_more: true, next_page_token: 'fresh-next-cursor', total_count: 0 }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_user_voices_v2', query_params: { next_page_token: '0' } });
  expect(result.isError, result.text).not.toBe(true); expect(payload(result).total_count).toBe(0); expect(fetch).toHaveBeenCalledOnce();
});

it.each(statuses)('collects static header records for success and HTTP %s diagnostics while preserving dynamic references', async status => {
  const headers = [{ type: 'static', key: 'Authorization', value: secret }, { type: 'dynamic', key: 'X-Region', value: 'customer_region' }];
  const config = transferTool(headers);
  const spellings = escapes(secret);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    expect(JSON.parse(options!.body as string)).toEqual({ tool_config: config });
    return Response.json(status === 200 ? { ...toolReply(config), diagnostic: spellings.join(' ') } : { detail: spellings.join(' ') }, { status });
  });
  const result = await pair.callTool('elevenlabs_create_resource', { operation_id: 'add_tool_route', body: { tool_config: config } });
  expect(Boolean(result.isError)).toBe(status !== 200);
  for (const spelling of spellings) expect(result.text).not.toContain(spelling);
  if (status === 200) expect(payload(result).tool_config.params.transfers[0].custom_sip_headers).toEqual([{ ...headers[0], value: '[REDACTED]' }, headers[1]]);
  expect(fetch).toHaveBeenCalledOnce();
});

it('derives header record values generally, including every reachable request and response occurrence', async () => {
  expect(credentialRequestPaths({ $ref: '#/$defs/ExampleHeader' }, { ExampleHeader: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } } })).toEqual([['value']]);
  const catalog = await loadApiCatalog(); const validator = await loadApiValidator();
  const requests: string[] = []; const responses: string[] = [];
  for (const op of catalog.operations) {
    for (const path of op.sensitive_request_fields ?? []) if (path.includes('custom_sip_headers')) {
      requests.push(op.operation_id);
      expect(sensitiveValues(plant(path, secret), op.sensitive_request_fields, validator.referenceGuard([op.request.schema]))).toContain(secret);
    }
    for (const path of op.sensitive_response_fields ?? []) if (path.includes('custom_sip_headers')) {
      responses.push(op.operation_id);
      expect(JSON.stringify(createRedactor([]).redact(plant(path, secret), { ...op, reference: validator.referenceGuard(op.responses.map(row => row.schema)) }))).not.toContain(secret);
    }
  }
  expect([...new Set(requests)].sort()).toEqual(['add_tool_route', 'create_agent_draft_route', 'create_agent_route', 'create_branch_route', 'patch_agent_settings_route', 'resubmit_tests_route', 'run_agent_test_suite_route', 'update_tool_route']);
  expect(new Set(responses).size).toBe(9);
});

it('hides stored tool headers, static records and agent tokens through registered reads without submitted secrets', async () => {
  const dynamic = { type: 'dynamic', key: 'X-Region', value: 'customer_region' };
  const configs = [transferTool([{ type: 'static', key: 'X-Private', value: secret }, dynamic]),
    { type: 'webhook', name: 'guide', description: 'guide', api_schema: { url: 'https://example.com/tool', method: 'GET', request_headers: { Authorization: secret, 'X-Reference': { secret_id: 'secret_reference' }, 'X-Region': { variable_name: 'customer_region' }, 'X-Env': { env_var_label: 'REGION' } } } }];
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const config of configs) {
    fetch.mockResolvedValueOnce(Response.json(toolReply(config)));
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_tool_route', path_params: { tool_id: 'tool_example' } });
    expect(result.json).toMatchObject({ response_contract: 'matched' }); expect(result.text).not.toContain(secret); expect(result.text).toContain('customer_region');
    if (config.type === 'webhook') expect(result.text).toContain('secret_reference');
  }
  fetch.mockResolvedValueOnce(Response.json({ agent_id: 'agent_example', name: 'Guide', conversation_config: {}, metadata: { created_at_unix_secs: 1, updated_at_unix_secs: 2 }, platform_settings: { auth: { shareable_token: secret } } }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_agent_route', path_params: { agent_id: 'agent_example' } });
  expect(result.json).toMatchObject({ response_contract: 'matched' }); expect(result.text).not.toContain(secret); expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(['get_conversation_sip_messages', 'list_sip_messages'])('%s masks scalar, object and array drift opaquely, without inventing raw-message locator alternatives', async id => {
  const op = await getOperation(id);
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const raw_message of [secret, { wire: secret }, [secret], { secret_id: secret }, { variable_name: secret }]) {
    fetch.mockResolvedValueOnce(Response.json({ sip_messages: [{ raw_message }], has_more: false, next_cursor: null }));
    const result = await pair.callTool(tool(op), { operation_id: id, path_params: Object.fromEntries(op.parameters.path.required.map(name => [name, 'example'])) });
    expect(result.isError, result.text).not.toBe(true); expect(payload(result).sip_messages[0].raw_message).toBe('[REDACTED]'); expect(result.text).not.toContain(secret);
  }
  expect(fetch).toHaveBeenCalledTimes(5);
});

it('keeps only schema-supported header locators and makes all other sensitive structured leaves opaque', async () => {
  const op = await getOperation('get_tool_route'); const validator = await loadApiValidator();
  for (const value of [{ wire: secret }, [secret], { secret_id: 'reference', wire: secret }, { variable_name: secret, extra: true }]) {
    const data = toolReply({ type: 'webhook', api_schema: { request_headers: { 'X-Private': value } } });
    const clean = createRedactor([]).redact(data, { ...op, reference: validator.referenceGuard(op.responses.map(row => row.schema)) });
    expect(JSON.stringify(clean)).not.toContain(secret);
    expect((clean as typeof data).tool_config).toEqual({ type: 'webhook', api_schema: { request_headers: { 'X-Private': '[REDACTED]' } } });
  }
});

it.each([400, 401, 403, 422, 500].flatMap(status => ['plain', 'truncated'].map(kind => ({ status, kind }))))('contains $kind error bodies and status text at HTTP $status', async ({ status, kind }) => {
  const echo = [...escapes(secret), ...escapes(key)].join(' ');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(kind === 'plain' ? echo : `{"detail":"${echo}`, { status, statusText: encodeURIComponent(secret) + ' ' + encodeURIComponent(key) }));
  const result = await pair.callTool('elevenlabs_run_job', { operation_id: 'speech_to_text', query_params: { token: secret }, body: { model_id: 'scribe_v2', cloud_storage_url: 'https://example.com/clip.mp3' } });
  expect(result.isError).toBe(true);
  for (const spelling of [...escapes(secret), ...escapes(key)]) expect(result.text).not.toContain(spelling);
  if (![401, 403].includes(status)) expect(result.text).toContain('[REDACTED]');
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['text/plain', 'text/html'])('redacts known raw, encoded and JSON-escaped secrets in ordinary %s replies before wrapping', async media => {
  const op = structuredClone(await getOperation('get_knowledge_base_content'));
  const get = catalogModule.getOperation;
  vi.spyOn(catalogModule, 'getOperation').mockImplementation(async (id, profile) => id === op.operation_id ? op : get(id, profile));
  op.responses = [{ status: 200, media_type: media, schema: { type: 'string' } }];
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response([...escapes(secret), ...escapes(key)].join(' '), { headers: { 'Content-Type': media } }));
  try {
    const result = await executeApiOperation('read', { operation_id: op.operation_id, path_params: { documentation_id: 'example' } });
    // Known submitted values use the same textual receipt seam without a credential-return exemption.
    const receipt = await createSuccessReceipt(op.operation_id, 200, media, [...escapes(secret), ...escapes(key)].join(' '), createRedactor([key, secret]));
    expect(result.data).not.toContain(key);
    for (const spelling of [...escapes(secret), ...escapes(key)]) expect(receipt.data).not.toContain(spelling);
    expect(receipt.data).toMatch(/^<untrusted-content/); expect(fetch).toHaveBeenCalledOnce();
  } finally { vi.restoreAllMocks(); }
});

it('covers the previously uncovered 37 stored header paths in 11 operations, with independent stored canaries', async () => {
  expect(storedHeaders).toHaveLength(37); expect(new Set(storedHeaders.map(row => row.id)).size).toBe(11);
  const validator = await loadApiValidator();
  for (const row of storedHeaders) {
    const op = await getOperation(row.id);
    expect(op.sensitive_response_fields, row.id + ':' + row.path.join('.')).toContainEqual(row.path);
    const data = plant(row.path, secret);
    const clean = createRedactor([]).redact(data, { ...op, reference: validator.referenceGuard(op.responses.map(row => row.schema)) });
    expect(JSON.stringify(clean), row.id + ':' + row.path.join('.')).not.toContain(secret);
  }
});

it('declares signed asset, generation, Studio and template media URLs centrally while returning them by design', async () => {
  const expected: Record<string, string[][]> = {
    get_asset: [['content_url']], upload_asset: [['content_url']], list_assets: [['assets', '*', 'content_url']],
    get_image_generation: [['content_url']], get_video_generation: [['content_url']], get_text_to_speech_generation: [['content_url']],
    list_image_generations: [['generations', '*', 'content_url']], list_video_generations: [['generations', '*', 'content_url']], list_text_to_speech_generations: [['generations', '*', 'content_url']],
    get_project_by_id: [['assets', '*', 'signed_url'], ['assets', '*', 'asset_preview_signed_url'],
      ['assets', '*', 'signed_preview_url'], ['assets', '*', 'thumbnail_sheets', '*', 'signed_cloud_url'], ['assets', '*', 'thumbnail_signed_url']],
    create_public_template_run: [['outputs', '*', 'content_url']], get_public_template_run: [['outputs', '*', 'content_url']], list_public_template_runs: [['runs', '*', 'outputs', '*', 'content_url']],
  };
  const catalog = await loadApiCatalog();
  for (const [id, paths] of Object.entries(expected)) {
    const op = await getOperation(id);
    for (const path of paths) {
      expect(op.credential_return_fields, id).toContainEqual(path);
      const data = plant(path, secret);
      expect(JSON.stringify(createRedactor([]).redact(data, op))).toContain(secret);
      expect(JSON.stringify(createRedactor([secret]).redact(data, op))).not.toContain(secret);
    }
  }
  const wires = [...assets, ...flows, ...studio, ...templates];
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const id of Object.keys(expected)) {
    const row = wires.find(row => row.id === id)!;
    expect(row, id).toBeDefined();
    const op = catalog.operations.find(op => op.operation_id === id)!;
    fetch.mockResolvedValueOnce(Response.json(row.response, { status: row.status }));
    const file = join(workspace, 'sample.mp3'); await writeFile(file, Buffer.from([0, 128]));
    const result = await pair.callTool(op.tool, { operation_id: id, ...row.args, ...(op.request.files?.length ? { files: op.request.files.map(binding => ({ field: binding.field, file_path: file })) } : {}) });
    expect(result.isError, result.text).not.toBe(true); expect(result.json).toMatchObject({ response_contract: 'matched' });
    expect(payload(result)).toEqual(row.response);
  }
  expect(fetch).toHaveBeenCalledTimes(13);
});

it.each(['asset_preview_signed_url', 'signed_preview_url', 'thumbnail_signed_url', 'signed_cloud_url'])('declares %s while masking credential branches beneath it', async field => {
  const op = await getOperation('get_project_by_id');
  const path = ['assets', '*', ...(field === 'signed_cloud_url' ? ['thumbnail_sheets', '*'] : []), field];
  expect(op.credential_return_fields).toContainEqual(path);
  const response = plant(path, { token: 'canary-secret-0001' });
  expect(JSON.stringify(createRedactor([]).redact(response, op))).not.toContain('canary-secret-0001');
});

it.each([true, false, 'exception'] as const)('redacts the current and newly submitted account keys in bridge %s replies', async outcome => {
  const nextKey = 'synthetic-widget/signature+value?';
  const state = join(workspace, 'bridge-state.json');
  await writeFile(state, JSON.stringify({ port: 12345, token: 'synthetic-bridge-token-123456789' }), { mode: 0o600 });
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', state);
  const echo = [...escapes(key), ...escapes(nextKey)].join(' ');
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (outcome === 'exception') throw new Error(echo);
    return Response.json(outcome ? { success: true, warning: echo } : { success: false, error: echo });
  });
  const result = await pair.callTool('configure_elevenlabs_api_key', { api_key: nextKey });
  expect(Boolean(result.isError)).toBe(outcome !== true);
  for (const spelling of [...escapes(key), ...escapes(nextKey)]) expect(result.text).not.toContain(spelling);
  expect(result.text).toContain('[REDACTED]'); expect(result.text).toContain('untrusted-content'); expect(fetch).toHaveBeenCalledOnce();
});

it.each(['generate_speech', 'get_history_item_audio'])('redacts downstream %s body-reader exceptions at the shared tool boundary', async name => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream({ start(controller) {
    controller.error(new Error(escapes(key).join(' ')));
  } }), { headers: { 'Content-Type': 'audio/mpeg' } }));
  const result = await pair.callTool(name, name === 'generate_speech' ? { text: 'Guide', voice_id: 'voice_example' } : { history_item_id: 'history_example' });
  expect(result.isError).toBe(true); expect(result.text).toContain('[REDACTED]'); expect(result.text).toContain('untrusted-content');
  for (const spelling of escapes(key)) expect(result.text).not.toContain(spelling);
  expect(fetch).toHaveBeenCalledOnce();
});

const legacyFiles = [
  { name: 'transcribe_audio', args: (file: string) => ({ file_path: file }), field: 'file', response: { text: 'Guide', language_code: 'en', language_probability: 1, words: [] } },
  { name: 'forced_alignment', args: (file: string) => ({ file_path: file, text: 'Guide' }), field: 'file', response: { characters: [], words: [], loss: 0 } },
  { name: 'isolate_audio', args: (file: string) => ({ audio_path: file }), field: 'audio' },
  { name: 'speech_to_speech', args: (file: string) => ({ audio_path: file, voice_id: 'voice_example' }), field: 'audio' },
  { name: 'clone_voice', args: (file: string) => ({ files: [file], name: 'Guide' }), field: 'files', response: { voice_id: 'voice_example', requires_verification: false } },
  { name: 'create_dubbing', args: (file: string) => ({ file_path: file, target_lang: 'es' }), field: 'file', response: { dubbing_id: 'dubbing_example', expected_duration_sec: 1 } },
];
it.each(legacyFiles)('$name refuses credential documents before reading or dispatching, and still sends exact audio/video bytes', async row => {
  const source = join(workspace, 'credentials.json'); await writeFile(source, JSON.stringify({ api_key: secret }));
  const fetch = vi.spyOn(globalThis, 'fetch');
  const result = await pair.callTool(row.name, row.args(source));
  expect(result.isError, result.text).toBe(true); expect(result.text).toContain('INVALID_FILE_TYPE'); expect(fetch).not.toHaveBeenCalled();
  for (const [extension, media] of [['mp3', 'audio/mpeg'], ['mp4', 'video/mp4'], ['pcm', 'audio/pcm']]) {
    const bytes = Buffer.from([0, 128, 255, 127]); const file = join(workspace, `sample.${extension}`); await writeFile(file, bytes);
    fetch.mockImplementationOnce(async (url, options) => {
      const form = await new Request(String(url), options as RequestInit).formData(); const part = form.get(row.field) as File;
      expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes); expect(part.type).toBe(media);
      return row.response ? Response.json(row.response) : new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg' } });
    });
    const reply = await pair.callTool(row.name, row.args(file)); expect(reply.isError, reply.text).not.toBe(true);
  }
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(['check_subscription', 'get_history_item_audio'])('%s never forwards its account key to a cross-origin redirect', async name => {
  // Use native fetch and two loopback origins, as a fetch-options assertion alone cannot prove containment.
  mswServer.close();
  let reached = 0;
  const target = createHttpServer((_request, response) => { reached++; response.end(key); });
  const origin = createHttpServer((_request, response) => { response.writeHead(302, { Location: `http://127.0.0.1:${(target.address() as { port: number }).port}/target` }); response.end(); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const native = globalThis.fetch;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => native(`http://127.0.0.1:${(origin.address() as { port: number }).port}/request`, options));
  try {
    const result = await pair.callTool(name, name === 'check_subscription' ? {} : { history_item_id: 'history_example' });
    expect(result.isError).toBe(true); expect(result.text).toContain('HTTP_302'); expect(reached).toBe(0); expect(fetch).toHaveBeenCalledOnce();
  } finally {
    fetch.mockRestore();
    await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
    mswServer.listen({ onUnhandledRequest: 'error' });
  }
});

it('the authenticated client overrides an explicit follow request too', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302 }));
  await expect(elevenLabsFetch(key, '/example', { redirect: 'follow' })).rejects.toMatchObject({ code: 'HTTP_302' });
  expect(fetch.mock.calls[0][1]?.redirect).toBe('manual');
});

it.each([
  { name: 'check_subscription', args: {}, reply: (echo: string) => ({ tier: echo, status: 'active', character_count: 1, character_limit: 10 }) },
  { name: 'list_models', args: {}, reply: (echo: string) => [{ model_id: 'example', name: echo, can_do_text_to_speech: true }] },
  { name: 'list_voices', args: {}, reply: (echo: string) => ({ voices: [{ voice_id: 'voice_example', name: echo, labels: { [key]: echo } }], has_more: false }) },
  { name: 'get_voice', args: { voice_id: 'voice_example' }, reply: (echo: string) => ({ voice_id: 'voice_example', name: echo }) },
])('$name redacts parsed success data before projection, wrapping and JSON serialization', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(row.reply(escapes(key).join(' '))));
  const result = await pair.callTool(row.name, row.args);
  expect(result.isError, result.text).not.toBe(true); expect(result.text).toContain('[REDACTED]'); expect(result.text).toContain('untrusted-content');
  for (const spelling of escapes(key)) expect(result.text).not.toContain(spelling);
  expect(fetch).toHaveBeenCalledOnce();
});

it('declares recursive template media paths without exempting unsupported paths or credential-named descendants', async () => {
  const op = await getOperation('get_public_template_run');
  const declared = ['outputs', '*', 'content', '*', '**', 'content_url'];
  expect(op.credential_return_fields).toContainEqual(declared);
  for (const path of [['outputs', 'media', 'content', '0', 'content_url'], ['outputs', 'media', 'content', '0', 'content', 'child', 'content_url']]) expect(matchesFieldPath(declared, path)).toBe(true);
  expect(matchesFieldPath(declared, ['diagnostics', 'content_url'])).toBe(false);
  const validator = await loadApiValidator();
  const media = { id: 'media', status: 'completed', type: 'image', content_url: secret };
  const data = { run_id: 'example', status: 'completed', outputs: { nested: { id: 'outer', type: 'array', status: 'completed', has_more: false,
    content: [{ id: 'object', type: 'object', status: 'completed', content: { child: media } }] } } };
  const reference = validator.credentialReturnGuard(op.responses.map(row => row.schema));
  expect(reference(data, ['outputs', 'nested', 'content', '0', 'content', 'child', 'content_url'])).toBe(true);
  expect(reference(data, ['outputs', 'nested', 'content', '0', 'content', 'child', 'unrecognized'])).toBe(false);
  const drift = { outputs: { nested: { id: 'outer', type: 'string', status: 'completed', content: { child: media } } } };
  expect(reference(drift, ['outputs', 'nested', 'content', 'child', 'content_url'])).toBe(false);
  const clean = createRedactor([]).redact({ ...data, diagnostics: { content_url: { token: secret } } }, { ...op, credentialReturn: reference });
  expect(JSON.stringify(clean)).toContain(secret);
  expect((clean as { diagnostics: { content_url: { token: string } } }).diagnostics.content_url.token).toBe('[REDACTED]');
});

it('covers every static header component occurrence from the pinned schema graph, independently of the derivation rule', async () => {
  const catalog = await loadApiCatalog();
  function paths(schema: unknown, path: string[] = [], seen = new Set<string>()): string[][] {
    if (!schema || typeof schema !== 'object') return [];
    const node = schema as Record<string, unknown>;
    if (typeof node.$ref === 'string') {
      if (node.$ref.endsWith('/CustomSIPHeader') || node.$ref.endsWith('/AlertingWebhookHeader')) return [[...path, 'value']];
      if (seen.has(node.$ref)) return [];
      const next = new Set(seen); next.add(node.$ref);
      return paths(catalog.$defs[node.$ref.slice('#/$defs/'.length)], path, next);
    }
    return [
      ...Object.entries(node.properties ?? {}).flatMap(([key, child]) => paths(child, [...path, key], new Set(seen))),
      ...['anyOf', 'oneOf', 'allOf'].flatMap(key => (Array.isArray(node[key]) ? node[key] : []).flatMap(child => paths(child, path, new Set(seen)))),
      ...[node.items, node.additionalProperties].flatMap(child => paths(child, [...path, '*'], new Set(seen))),
    ];
  }
  const validator = await loadApiValidator();
  let requestCount = 0, responseCount = 0;
  for (const op of catalog.operations) {
    for (const path of paths(op.request.schema)) {
      requestCount++;
      expect(op.sensitive_request_fields, op.operation_id + ':' + path.join('.')).toContainEqual(path);
      expect(sensitiveValues(plant(path, secret), op.sensitive_request_fields!, validator.referenceGuard([op.request.schema]))).toContain(secret);
    }
    for (const path of op.responses.flatMap(row => paths(row.schema))) {
      responseCount++;
      expect(op.sensitive_response_fields, op.operation_id + ':' + path.join('.')).toContainEqual(path);
    }
  }
  expect(requestCount).toBeGreaterThan(8); expect(responseCount).toBeGreaterThan(11);
});

it('removes the account key from an older tool\'s own error message and resolution', async () => {
  const handler = withErrorHandling(async () => { throw new ElevenLabsError(`Request failed for ${key}`, 'HTTP_401', `Check the key ${key}`); });
  const result = await handler({}, {});
  const text = result.content.map(part => ('text' in part ? part.text : '')).join('');
  expect(result.isError).toBe(true); expect(text).toContain('[REDACTED]'); expect(text).toContain('HTTP_401');
  for (const spelling of escapes(key)) expect(text).not.toContain(spelling);
});

it('masks a credential-named branch at a recursive return path whose value the schema does not support there', async () => {
  const op = await getOperation('get_public_template_run');
  const validator = await loadApiValidator();
  const media = { id: 'media', status: 'completed', type: 'image', content_url: 'https://media.example/issued' };
  const data = { run_id: 'example', status: 'completed', outputs: { nested: { id: 'outer', type: 'array', status: 'completed', has_more: false,
    content: [{ id: 'object', type: 'object', status: 'completed', content: { child: media, token: { content_url: secret } } }] } } };
  const path = ['outputs', 'nested', 'content', '0', 'content', 'token', 'content_url'];
  expect(op.credential_return_fields!.some(declared => matchesFieldPath(declared, path))).toBe(true);
  const credentialReturn = validator.credentialReturnGuard(op.responses.map(row => row.schema));
  expect(credentialReturn(data, path)).toBe(false);
  const clean = createRedactor([]).redact(data, { ...op, credentialReturn }) as typeof data;
  expect(clean.outputs.nested.content[0].content.child.content_url).toBe(media.content_url);
  expect(clean.outputs.nested.content[0].content.token.content_url).toBe('[REDACTED]');
});
