import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { http, HttpResponse } from 'msw';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import { setApiKey } from '../src/auth.js';
import { getOperation, loadApiCatalog } from '../src/api-catalog.js';
import { validateRequest } from '../src/api-validation.js';
import { createRedactor } from '../src/api-sensitive.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import { mswServer } from './helpers/setup.js';
import cases from './fixtures/api-flows-wire-cases.json' with { type: 'json' };
import templates from './fixtures/api-templates-wire-cases.json' with { type: 'json' };

let pair: McpTestClient, workspace: string;
const args = (row: typeof cases[number]) => ({ operation_id: row.id, ...row.args });
const tool = (profile: string) => profile === 'run_job' ? 'elevenlabs_run_job' : `elevenlabs_${profile}_resource`;
const receipt = (text: string) => JSON.parse(text);
const data = (text: string) => JSON.parse(unwrapUntrusted(receipt(text).data));
const creates = cases.filter(row => row.profile === 'run_job');
const gets = cases.filter(row => row.id.startsWith('get_'));
const lists = cases.filter(row => row.id.startsWith('list_'));
const imageModels = ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gemini-2.5-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'bytedance-seedream-5-lite', 'bytedance-seedream-5-pro'];
const videoModels = ['creatify-aurora', 'veo-3.1-generate-001', 'veo-3.1-fast-generate-001', 'bytedance-seedance-v2', 'bytedance-seedance-v2-fast', 'bytedance-seedance-v2-mini', 'bytedance-seedance-v2.5'];
const speechModels = ['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3'];
const asset = { type: 'asset', asset_id: 'asset_example' };
const generation = { type: 'generation', generation_id: 'gen_example' };
const inline = (mime_type: string) => ({ type: 'inline_base64', content_base64: 'AAECAw==', mime_type });
const validate = (operation_id: string, body: unknown) => validateRequest('run_job', { operation_id, body }, createRedactor('synthetic-flows-key'));
beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flows-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace); setApiKey('synthetic-flows-key');
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => {
  await pair.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setApiKey('');
  fs.rmSync(workspace, { recursive: true, force: true });
});

it.each(cases)('$id preserves its literal SDK wire contract, effects and result without extra requests', async row => {
  const requests: Request[] = [];
  mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => {
    requests.push(request);
    expect(request.method).toBe(row.method); expect(new URL(request.url).pathname).toBe(row.path);
    expect([...new URL(request.url).searchParams]).toEqual(row.query);
    expect(await request.text()).toBe(row.args.body === undefined ? '' : JSON.stringify(row.args.body));
    expect(request.headers.get('xi-api-key')).toBe('synthetic-flows-key'); expect(request.redirect).toBe('manual');
    return HttpResponse.json(row.response);
  }));
  const fetch = vi.spyOn(globalThis, 'fetch');
  const result = await pair.callTool(tool(row.profile), args(row));
  expect(result.isError, result.text).not.toBe(true); expect(requests).toHaveLength(1); expect(fetch).toHaveBeenCalledOnce();
  expect(receipt(result.text)).toMatchObject({ status: 200, response_contract: 'matched', follow_up_operations: row.follow_ups, effects: {
    readOnlyHint: row.profile === 'read', destructiveHint: false, idempotentHint: row.profile === 'read', openWorldHint: true,
  } });
  expect(data(result.text)).toEqual(row.response);
  expect(receipt(result.text).data).toMatch(/^<untrusted-content source="elevenlabs:api:/);
  const op = await getOperation(row.id);
  expect(op.timeout).toBe('standard'); expect(op.request.files).toBeUndefined();
  expect(op.sensitive_request_fields ?? []).toEqual([]); expect(op.sensitive_response_fields ?? []).toEqual([]);
  expect(fs.readdirSync(workspace)).toEqual([]);
});

it.each([
  ['create_image_generation', imageModels, 'ImageGenerationRequest'],
  ['create_video_generation', videoModels, 'VideoGenerationRequest'],
  ['create_text_to_speech_generation', speechModels, 'TextToSpeechGenerationRequest'],
] as const)('%s validates every pinned model discriminator and rejects missing/unknown models without dispatch', async (id, models, definition) => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const catalog = await loadApiCatalog();
  expect(catalog.$defs[definition]).toMatchObject({ discriminator: { propertyName: 'model_id' } });
  const schema = catalog.$defs[definition] as { discriminator: { mapping: Record<string, string> }; oneOf: unknown[] };
  expect(Object.keys(schema.discriminator.mapping).sort()).toEqual([...models].sort());
  expect(schema.oneOf).toHaveLength(models.length);
  for (const model_id of models) {
    const body = id.includes('text_to_speech') ? { model_id, voice: 'voice_example', text: 'Hello.' }
      : model_id === 'creatify-aurora' ? { model_id, image: asset, audio: asset } : { model_id, prompt: 'A quiet garden' };
    await expect(validate(id, body)).resolves.toMatchObject({ body });
    const { model_id: omitted, ...missing } = body;
    expect(omitted).toBe(model_id);
    await expect(validate(id, missing)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(validate(id, { ...body, model_id: 'not-a-pinned-model' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('preserves every reference and webhook discriminator, inline limits and the TTS voice field', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const catalog = await loadApiCatalog();
  for (const definition of ['ImageReference', 'AudioReference', 'VideoReference']) {
    expect(catalog.$defs[definition]).toMatchObject({ discriminator: { propertyName: 'type', mapping: {
      asset: '#/$defs/StaticAssetReference', generation: '#/$defs/GenerationReference',
      inline_base64: `#/$defs/Inline${definition}`,
    } } });
  }
  expect(catalog.$defs.WebhookTarget).toMatchObject({ discriminator: { propertyName: 'type', mapping: {
    all: '#/$defs/WebhookTargetAll', ids: '#/$defs/WebhookTargetIds',
  } } });
  for (const definition of ['InlineImageReference', 'InlineAudioReference', 'InlineVideoReference']) {
    expect(catalog.$defs[definition]).toMatchObject({ properties: { content_base64: { maxLength: 34952536 } } });
  }
  for (const reference of [asset, generation, inline('image/png')]) {
    await expect(validate('create_image_generation', { model_id: 'gpt-image-1', prompt: 'Garden', images: [reference], mask: reference })).resolves.toBeDefined();
  }
  for (const type of ['asset', 'generation', 'inline_base64']) {
    const ref = (mime: string) => type === 'asset' ? asset : type === 'generation' ? generation : inline(mime);
    await expect(validate('create_video_generation', { model_id: 'creatify-aurora', image: ref('image/png'), audio: ref('audio/wav') })).resolves.toBeDefined();
    await expect(validate('create_video_generation', { model_id: 'bytedance-seedance-v2.5', prompt: 'Garden', videos: [ref('video/mp4')], audios: [ref('audio/mpeg')] })).resolves.toBeDefined();
  }
  for (const row of creates) {
    for (const webhook of [undefined, null, { type: 'all' }, { type: 'ids', ids: ['hook_one'] }]) {
      await expect(validate(row.id, { ...row.args.body, webhook })).resolves.toBeDefined();
    }
    for (const webhook of [{ type: 'url', url: 'https://hooks.example.com' }, { type: 'ids', ids: [] }, { type: 'ids' }]) {
      await expect(validate(row.id, { ...row.args.body, webhook })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  }
  for (const model_id of speechModels) {
    await expect(validate('create_text_to_speech_generation', { model_id, text: 'Hello', voice_id: 'voice_wrong' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  }
  for (const reference of [{ type: 'asset' }, { type: 'generation' }, { ...inline('text/plain') }, { type: 'url', url: 'https://media.example.com' }]) {
    await expect(validate('create_image_generation', { model_id: 'gpt-image-1', prompt: 'Garden', images: [reference] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it.each(gets)('$id preserves all lifecycle branches without fetching signed media, polling, files or URL logs', async row => {
  const content_url = 'https://media.example.com/result?signature=synthetic/+?';
  const branches = [
    { id: 'gen_example', status: 'pending' }, { id: 'gen_example', status: 'generating' },
    { id: 'gen_example', status: 'completed', content_url, content_mime_type: 'application/example' },
    { id: 'gen_example', status: 'failed', failure_reason: 'model_error', error_message: 'Synthetic failure </untrusted-content>' },
  ];
  const fetch = vi.spyOn(globalThis, 'fetch');
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
  for (const [index, response] of branches.entries()) {
    fetch.mockResolvedValueOnce(Response.json(response));
    const result = await pair.callTool(tool(row.profile), args(row));
    expect(result.isError, result.text).not.toBe(true); expect(receipt(result.text).response_contract).toBe('matched');
    expect(data(result.text)).toEqual(response); expect(fetch).toHaveBeenCalledTimes(index + 1);
  }
  for (const [url] of fetch.mock.calls) expect(String(url)).toBe(`https://api.elevenlabs.io${row.path}`);
  expect(fs.readdirSync(workspace)).toEqual([]);
  for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(content_url);
});

it.each(creates)('$id uses its returned ID for an explicit read, while lost IDs have no list fallback', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(row.response));
  const result = await pair.callTool(tool(row.profile), args(row));
  expect(result.isError, result.text).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(receipt(result.text).next_step).toContain(row.follow_ups[0]);
  fetch.mockResolvedValueOnce(Response.json({ id: data(result.text).id, status: 'generating' }));
  const read = await pair.callTool('elevenlabs_read_resource', { operation_id: row.follow_ups[0], path_params: { generation_id: data(result.text).id } });
  expect(read.isError, read.text).not.toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1][0])).toBe(`https://api.elevenlabs.io${row.path}/${data(result.text).id}`);
  fetch.mockRejectedValueOnce(new TypeError('Synthetic response loss'));
  const lost = await pair.callTool(tool(row.profile), args(row));
  expect(lost.isError).toBe(true); expect(fetch).toHaveBeenCalledTimes(3);
  const op = await getOperation(row.id);
  expect(op.retry_check).toHaveProperty('unavailable_reason');
  expect(lost.text).toContain((op.retry_check as { unavailable_reason: string }).unavailable_reason);
  expect(lost.text).toContain('No automatic retry'); expect(lost.text).not.toContain('Check the result with list_');
});

it.each(lists)('$id continues only explicitly and rejects invalid page sizes', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ generations: [{ id: 'gen_example', status: 'generating' }], next_cursor: 'next/+?', has_more: true }));
  const first = await pair.callTool(tool(row.profile), args(row));
  expect(first.isError, first.text).not.toBe(true); expect(receipt(first.text).next).toContain('query_params.cursor'); expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValueOnce(Response.json({ generations: [], next_cursor: null, has_more: false }));
  const second = await pair.callTool(tool(row.profile), { ...args(row), query_params: { cursor: data(first.text).next_cursor, page_size: 100 } });
  expect(second.isError, second.text).not.toBe(true); expect(receipt(second.text).next).toBeUndefined();
  expect([...new URL(String(fetch.mock.calls[1][0])).searchParams]).toEqual([['cursor', 'next/+?'], ['page_size', '100']]);
  for (const page_size of [0, 101]) expect((await pair.callTool(tool(row.profile), { ...args(row), query_params: { page_size } })).isError).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(cases)('$id exposes truthful charges, retry and webhook/media guidance in discovery', async row => {
  const op = await getOperation(row.id);
  const result = await pair.callTool('elevenlabs_discover_api', { operation_id: row.id });
  expect(result.isError, result.text).not.toBe(true);
  if (row.profile === 'run_job') {
    expect(result.text).toContain(row.id.includes('text_to_speech') ? 'charged per character' : 'may consume credits');
    for (const text of ['failed generations are documented as uncharged', 'not a refund promise', 'configured workspace Flows webhooks', 'provider then delivers', 'no local file read or automatic asset upload']) expect(result.text).toContain(text);
  } else {
    expect(result.text).toContain('no endpoint fee is stated'); expect(op.retry_check).toBe(row.id);
    for (const text of ['about an hour after the read', 're-read the resource for a fresh URL', 'never fetched or used in filenames or logs']) expect(result.text).toContain(text);
  }
});

it.each(cases)('$id refuses every wrong profile and all file bindings with zero requests', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const profile of ['read_resource', 'create_resource', 'change_resource', 'delete_resource', 'run_job', 'run_agent_tests', 'query_knowledge', 'place_call'].filter(profile => `elevenlabs_${profile}` !== tool(row.profile))) {
    const refused = await pair.callTool(`elevenlabs_${profile}`, args(row));
    expect(refused.isError).toBe(true); expect(refused.text).toContain('WRONG_TOOL');
  }
  const refused = await pair.callTool(tool(row.profile), { ...args(row), files: [{ field: 'image', file_path: path.join(workspace, 'never-read') }] });
  expect(refused.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
});

it.each(templates)('$id preserves the literal template wire contract, destructive execution and wrapped outputs', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => {
    expect(request.method).toBe(row.method); expect(new URL(request.url).pathname).toBe(row.path);
    expect([...new URL(request.url).searchParams]).toEqual(row.query);
    expect(await request.text()).toBe(row.args.body === undefined ? '' : JSON.stringify(row.args.body));
    expect(request.headers.get('xi-api-key')).toBe('synthetic-flows-key'); expect(request.redirect).toBe('manual');
    return HttpResponse.json(row.response);
  }));
  const result = await pair.callTool(tool(row.profile), { operation_id: row.id, ...row.args });
  expect(result.isError, result.text).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(receipt(result.text)).toMatchObject({ status: 200, response_contract: 'matched', follow_up_operations: row.follow_ups,
    effects: { readOnlyHint: row.profile === 'read', destructiveHint: row.profile === 'change', idempotentHint: row.profile === 'read', openWorldHint: true } });
  expect(data(result.text)).toEqual(row.response);
  expect(receipt(result.text).data.match(/<untrusted-content /g)).toHaveLength(1);
  expect(receipt(result.text).data.match(/<\/untrusted-content>/g)).toHaveLength(1);
  const op = await getOperation(row.id);
  expect(op.timeout).toBe('standard'); expect(op.request.files).toBeUndefined();
  expect(op.sensitive_request_fields ?? []).toEqual([]); expect(op.sensitive_response_fields ?? []).toEqual([]);
  expect(op.credential_return_fields).toBeUndefined(); expect(fs.readdirSync(workspace)).toEqual([]);
});

it('validates template version, input port values, references and webhook selection without adding business validators', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const run = (body: unknown) => validateRequest('change', { operation_id: 'create_public_template_run', path_params: { template_id: 'template_example' }, body }, createRedactor([]));
  for (const version_id of [undefined, null, 'latest', 'version_pinned']) {
    for (const webhook of [undefined, null, { type: 'all' }, { type: 'ids', ids: ['hook_one'] }]) {
      await expect(run({ inputs: {}, version_id, webhook })).resolves.toBeDefined();
    }
  }
  const inputs = { text_port: 'text', number_port: 0.5, integer_port: 2, boolean_port: false,
    image_port: asset, video_port: generation, voice_port: { type: 'voice', voice_id: 'voice_example' },
    audio_port: inline('audio/wav'), array_port: ['text', [true, 2, generation]] };
  await expect(run({ inputs })).resolves.toMatchObject({ body: { inputs } });
  for (const body of [
    {}, { inputs: {}, version_id: '' }, { inputs: { object_port: { title: 'not bindable' } } },
    { inputs: { voice_port: { type: 'voice' } } }, { inputs: { image_port: { type: 'asset' } } },
    { inputs: { video_port: { type: 'generation' } } }, { inputs: { audio_port: inline('text/plain') } },
    { inputs: { image_port: { type: 'url', url: 'https://media.example.com/image' } } },
    { inputs: { array_port: Array(65).fill('text') } },
    { inputs: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`port_${i}`, 'text'])) },
    { inputs: {}, webhook: { type: 'url', url: 'https://hooks.example.com' } },
    { inputs: {}, webhook: { type: 'ids', ids: [] } }, { inputs: {}, webhook: { type: 'ids' } },
  ]) await expect(run(body)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  // Published port IDs, required ports and port-specific enums are validated by the provider.
  await expect(run({ inputs: { unknown_port: 'provider decides' } })).resolves.toBeDefined();
  const catalog = await loadApiCatalog();
  expect(catalog.$defs.TemplatePort).toMatchObject({ properties: { content_schema: { description: expect.stringContaining('object` inputs cannot be bound') } } });
  expect(catalog.$defs.TemplateInputReference).toMatchObject({ discriminator: { propertyName: 'type', mapping: {
    asset: '#/$defs/StaticAssetReference', generation: '#/$defs/GenerationReference', inline_base64: '#/$defs/InlineBase64Reference', voice: '#/$defs/VoiceReference',
  } } });
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps mixed typed output states and reserved nested output cursors as data without a continuation or media fetch', async () => {
  const row = templates.find(row => row.id === 'get_public_template_run')!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(row.response));
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: row.id, ...row.args });
  expect(result.isError, result.text).not.toBe(true); expect(receipt(result.text).response_contract).toBe('matched');
  const run = data(result.text);
  expect(run.status).toBe('generating'); expect(run.outputs.audio_port.status).toBe('failed');
  expect(Object.values(run.outputs).map(output => (output as { type: string }).type).sort()).toEqual(['array', 'audio', 'boolean', 'image', 'integer', 'number', 'object', 'string', 'video']);
  expect(run.outputs.array_port).toMatchObject({ next_cursor: 'nested/+?', has_more: true });
  expect(run.outputs.object_port.content.title.content).toBe('Garden');
  expect(receipt(result.text).next).toBeUndefined(); expect((await getOperation(row.id)).pagination).toBeNull();
  expect(fetch).toHaveBeenCalledOnce(); expect(fs.readdirSync(workspace)).toEqual([]);
  for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain('https://media.example.com');
});

it('uses a known run ID with the template ID, but never recommends the run list after response loss', async () => {
  const row = templates[0];
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(row.response));
  const result = await pair.callTool('elevenlabs_change_resource', { operation_id: row.id, ...row.args });
  expect(result.isError, result.text).not.toBe(true); expect(receipt(result.text).next_step).toContain('get_public_template_run');
  expect(receipt(result.text).next_step).toContain('path_params.template_id'); expect(receipt(result.text).next_step).toContain('path_params.run_id');
  const run = data(result.text);
  fetch.mockResolvedValueOnce(Response.json(run));
  const read = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_public_template_run', path_params: { template_id: run.template_id, run_id: run.id } });
  expect(read.isError, read.text).not.toBe(true);
  expect(String(fetch.mock.calls[1][0])).toBe('https://api.elevenlabs.io/v1/flows/templates/template_example/runs/run_example');
  fetch.mockRejectedValueOnce(new TypeError('Synthetic response loss'));
  const lost = await pair.callTool('elevenlabs_change_resource', { operation_id: row.id, ...row.args });
  expect(lost.isError).toBe(true); expect(lost.text).toContain('No reliable lookup after losing the run ID');
  expect(lost.text).toContain('no submitted inputs or correlation token'); expect(lost.text).toContain('No automatic retry');
  expect(lost.text).not.toContain('Check the result with list_public_template_runs'); expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(templates.filter(row => row.profile === 'read'))('$id overrides the unavailable Flows default with an explicit self retry check', async row => {
  const op = await getOperation(row.id);
  expect(op.retry_check).toBe(row.id);
  expect(op.check_before_retry).toHaveProperty('unavailable_reason');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Synthetic read interruption'));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: row.id, ...row.args });
  expect(result.isError).toBe(true); expect(result.text).toContain(`Check the result with ${row.id}`);
  expect(result.text).not.toContain('No reliable lookup identifies a generation'); expect(fetch).toHaveBeenCalledOnce();
  const discovery = await pair.callTool('elevenlabs_discover_api', { operation_id: row.id });
  expect(discovery.text).toContain('Repeat the same read');
});

it.each(templates.filter(row => row.id.startsWith('list_')))('$id pages explicitly, including empty workspace template pages', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(row.response));
  const first = await pair.callTool('elevenlabs_read_resource', { operation_id: row.id, ...row.args });
  expect(first.isError, first.text).not.toBe(true); expect(receipt(first.text).next).toContain('query_params.cursor'); expect(fetch).toHaveBeenCalledOnce();
  const response = row.id === 'list_public_templates' ? { templates: [], next_cursor: null, has_more: false } : { runs: [], next_cursor: null, has_more: false };
  fetch.mockResolvedValueOnce(Response.json(response));
  const second = await pair.callTool('elevenlabs_read_resource', { operation_id: row.id, ...row.args, query_params: { ...row.args.query_params, cursor: data(first.text).next_cursor } });
  expect(second.isError, second.text).not.toBe(true); expect(receipt(second.text).next).toBeUndefined();
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('cursor')).toBe(row.response.next_cursor);
  for (const page_size of [0, row.id === 'list_public_templates' ? 26 : 101]) {
    expect((await pair.callTool('elevenlabs_read_resource', { operation_id: row.id, ...row.args, query_params: { page_size } })).isError).toBe(true);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('discloses template scope, foreign workflows, billing, output inspection and unrunnable versions', async () => {
  const expectations: Record<string, string[]> = {
    create_public_template_run: ['another workspace', 'supplied data through its workflow', 'configured webhooks', 'may consume credits', 'individual failed generations are uncharged', 'without a blanket refund promise', 'keyed by port ID', 'object input ports cannot be bound', 'live draft'],
    get_public_template: ['Empty versions means no published version is runnable', 'Shared-by-link', 'other-workspace Explore'],
    get_public_template_run: ['Inspect each output, not just the rolled-up run state', 'no admitted continuation endpoint', 'about an hour'],
    list_public_template_runs: ['A matching version does not mean matching inputs'],
    list_public_templates: ['this workspace only', 'not templates shared by link', "other workspaces' Explore templates"],
  };
  for (const [operation_id, texts] of Object.entries(expectations)) {
    const discovery = await pair.callTool('elevenlabs_discover_api', { operation_id });
    expect(discovery.isError, discovery.text).not.toBe(true);
    for (const text of texts) expect(discovery.text).toContain(text);
  }
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ id: 'template_shared', name: 'Acme', versions: [], has_more_versions: false }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_public_template', path_params: { template_id: 'template_shared' } });
  expect(receipt(result.text).response_contract).toBe('matched'); expect(data(result.text).versions).toEqual([]); expect(fetch).toHaveBeenCalledOnce();
});

it.each(templates)('$id refuses every wrong profile and file operand with zero requests', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const profile of ['read_resource', 'create_resource', 'change_resource', 'delete_resource', 'run_job', 'run_agent_tests', 'query_knowledge', 'place_call'].filter(profile => `elevenlabs_${profile}` !== tool(row.profile))) {
    const result = await pair.callTool(`elevenlabs_${profile}`, { operation_id: row.id, ...row.args });
    expect(result.isError).toBe(true); expect(result.text).toContain('WRONG_TOOL'); expect(fetch).not.toHaveBeenCalled();
  }
  const refused = await pair.callTool(tool(row.profile), { operation_id: row.id, ...row.args, files: [{ field: 'inputs', file_path: path.join(workspace, 'never-read') }] });
  expect(refused.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
});
