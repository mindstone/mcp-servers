import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import { setApiKey } from '../src/auth.js';
import { executeApiOperation } from '../src/api-executor.js';
import { getOperation } from '../src/api-catalog.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
import * as validation from '../src/api-validation.js';
import { isBinaryMedia } from '../src/api-media.mjs';
import cases from './fixtures/api-supporting-wire-cases.json' with { type: 'json' };
import { mockHistory, mockWorkspaceUsage, mockPronunciationDictionaryList, mockPronunciationDictionaryDetail, mockAddPronunciationDictionary } from './fixtures/elevenlabs-data.js';
import legacy from './fixtures/legacy-tools.json' with { type: 'json' };

vi.mock('fs', async original => ({ ...await original<typeof import('fs')>() }));
let workspace: string; let pair: McpTestClient;
beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supporting-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace); setApiKey('synthetic-supporting-key');
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => { await pair.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setApiKey(''); fs.rmSync(workspace, { recursive: true, force: true }); });
const wire = (id: string) => cases.find(row => row.id === id)!;
const tool = (profile: string) => profile === 'run_job' ? 'elevenlabs_run_job' : `elevenlabs_${profile}_resource`;
const data = (text: string) => JSON.parse(unwrapUntrusted(JSON.parse(text).data));
function args(id: string) {
  const source = wire(id);
  if (!('multipart' in source)) return { operation_id: id, ...source.args };
  const file = path.join(workspace, 'source.wav'); fs.writeFileSync(file, Buffer.from([82, 73, 70, 70, 0, 128, 255]));
  return { operation_id: id, ...source.args, files: [{ field: 'audio', file_path: file }] };
}

it('keeps history continuation literal and caller controlled', async () => {
  const source = wire('get_speech_history');
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(source.response));
  const first = await pair.callTool('elevenlabs_read_resource', args(source.id));
  expect(first.isError, first.text).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(data(first.text)).toEqual(source.response);
  expect(data(first.text)).toMatchObject({ last_history_item_id: 'history_example', has_more: true });
  const second = await pair.callTool('elevenlabs_read_resource', { operation_id: source.id, query_params: { start_after_history_item_id: 'history_example' } });
  expect(second.isError, second.text).not.toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('start_after_history_item_id')).toBe('history_example');
});
it('preserves isolation page/search semantics and refuses page zero without dispatch', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ items: [], has_more: true }));
  for (const query_params of [{ page: 3, page_size: 2, search: 'Acme' }, { page: 3, search: null }, {}]) {
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_audio_isolation_history', query_params });
    expect(result.isError, result.text).not.toBe(true); expect(data(result.text)).toEqual({ items: [], has_more: true });
  }
  expect(fetch).toHaveBeenCalledTimes(3);
  expect((await getOperation('get_audio_isolation_history')).effect_note).toContain('only used when search is provided');
  expect((await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_audio_isolation_history', query_params: { page: 0 } })).isError).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(3);
});
it.each([
  { ids: ['history_example'], media: 'audio/mpeg', extension: '.mp3', output_format: null },
  { ids: ['history_example'], media: 'audio/wav', extension: '.wav', output_format: 'wav' },
  { ids: ['history_second', 'history_example'], media: 'application/zip', extension: '.zip', output_format: null },
])('saves $media bytes and preserves ordered history IDs', async ({ ids, media, extension, output_format }) => {
  const bytes = Buffer.from([0, 128, 255, 10]);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': media } }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'download_speech_history_items', body: { history_item_ids: ids, output_format } });
  expect(result.isError, result.text).not.toBe(true);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ history_item_ids: ids, output_format });
  const receipt = JSON.parse(result.text); expect(receipt.artifact.media_type).toBe(media); expect(receipt.response_contract).toBe('matched');
  expect(path.extname(receipt.artifact.file_path)).toBe(extension); expect(fs.readFileSync(receipt.artifact.file_path)).toEqual(bytes);
});
it('keeps PLS bytes and exact version IDs while ignoring filenames and undeclared headers', async () => {
  const bytes = Buffer.from('<?xml version="1.0"?>\r\n<lexicon>é</lexicon>\n');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(bytes, { headers: {
    'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="../../provider.pls"', 'x-undeclared': 'private',
  } }));
  const result = await pair.callTool('elevenlabs_read_resource', args('get_pronunciation_dictionary_version_pls'));
  expect(result.isError, result.text).not.toBe(true); const receipt = JSON.parse(result.text);
  expect(String(fetch.mock.calls[0][0])).toContain('/Version%2FA%2B001%3D/download');
  expect(receipt.artifact.media_type).toBe('text/plain'); expect(path.extname(receipt.artifact.file_path)).toBe('.txt');
  expect(path.dirname(receipt.artifact.file_path)).toBe(workspace); expect(fs.readFileSync(receipt.artifact.file_path)).toEqual(bytes);
  expect(receipt.metadata).toBeUndefined(); expect(result.text).not.toContain('provider.pls');
  expect(result.text).not.toContain('x-undeclared');
});
it('distinguishes replacement, selective addition and removal, preserving new version IDs and archive state', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const id of ['set_rules', 'add_rules', 'remove_rules', 'patch_pronunciation_dictionary']) {
    const source = wire(id); fetch.mockResolvedValueOnce(Response.json(source.response));
    const result = await pair.callTool('elevenlabs_change_resource', args(id));
    expect(result.isError, result.text).not.toBe(true); expect(data(result.text)).toEqual(source.response);
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1]?.body))).toEqual(source.body);
    expect(JSON.parse(result.text).effects.destructiveHint).toBe(true);
  }
  expect((await getOperation('set_rules')).effect_reason).toContain('whole rule set');
  expect((await getOperation('add_rules')).effect_reason).toContain('only the named rules');
  expect((await getOperation('remove_rules')).effect_reason).toContain('only the named rules');
  expect((await getOperation('patch_pronunciation_dictionary')).effect_reason).toContain('without changing its version');
  const source = wire('get_pronunciation_dictionaries_metadata'); fetch.mockResolvedValueOnce(Response.json(source.response));
  const list = await pair.callTool('elevenlabs_read_resource', args(source.id));
  expect(data(list.text)).toEqual(source.response); expect(String(fetch.mock.calls.at(-1)![0])).toContain('include_archived=true');
});
it('preserves usage milliseconds, fractional values and aggregation fields without date conversion', async () => {
  const source = wire('usage_characters'), fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(source.response));
  const result = await pair.callTool('elevenlabs_read_resource', args(source.id));
  expect(result.isError, result.text).not.toBe(true); expect(data(result.text)).toEqual(source.response);
  expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('start_unix')).toBe('1735689600000');
  expect((await getOperation(source.id)).effect_note).toContain('overrides aggregation_interval');
});
it.each(['add_from_rules', 'set_rules', 'add_rules', 'remove_rules', 'patch_pronunciation_dictionary'])('%s can verify its own result through the declared follow-up read', async id => {
  const source = wire(id), base = wire('get_pronunciation_dictionary_metadata').response as Record<string, unknown>;
  const changed = source.response as Record<string, unknown>;
  const rules = id === 'remove_rules' ? [] : ['set_rules', 'add_from_rules'].includes(id) ? wire(id).body!.rules : base.rules;
  const metadata = { ...base, ...(id === 'patch_pronunciation_dictionary' ? changed : { latest_version_id: changed.version_id, latest_version_rules_num: changed.version_rules_num }), rules };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(source.response));
  const result = await pair.callTool(tool(source.profile), args(id)); expect(result.isError, result.text).not.toBe(true);
  const read = (await getOperation(id)).follow_ups[0];
  fetch.mockResolvedValueOnce(Response.json(id === 'add_from_rules' ? { pronunciation_dictionaries: [metadata], has_more: false, next_cursor: null } : metadata));
  const checked = await pair.callTool('elevenlabs_read_resource', { operation_id: read, ...(id === 'add_from_rules' ? {} : { path_params: { pronunciation_dictionary_id: changed.id } }) });
  expect(checked.isError, checked.text).not.toBe(true);
  const current = id === 'add_from_rules' ? data(checked.text).pronunciation_dictionaries[0] : data(checked.text);
  expect(current.id).toBe(changed.id);
  expect(current.latest_version_id).toBe(changed.version_id ?? changed.latest_version_id);
  if (id === 'patch_pronunciation_dictionary') expect(current.archived_time_unix).toBe(1735776000);
  if (id === 'remove_rules') expect(current.rules).toEqual([]);
  if (id === 'set_rules') expect(current.rules).toEqual(wire(id).body!.rules);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('restores archive state without creating a version and preserves empty selective rule arrays', async () => {
  const metadata = wire('get_pronunciation_dictionary_metadata').response as Record<string, unknown>;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(metadata));
  const result = await pair.callTool('elevenlabs_change_resource', { operation_id: 'patch_pronunciation_dictionary', path_params: { pronunciation_dictionary_id: 'dictionary_example' }, body: { archived: false } });
  expect(data(result.text)).toMatchObject({ latest_version_id: 'Version/A+001=', archived_time_unix: null });
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ archived: false });
  for (const [id, body] of [['set_rules', { rules: [] }], ['add_rules', { rules: [] }], ['remove_rules', { rule_strings: [] }]] as const) {
    fetch.mockResolvedValueOnce(Response.json(wire(id).response));
    const changed = await pair.callTool('elevenlabs_change_resource', { operation_id: id, path_params: { pronunciation_dictionary_id: 'dictionary_example' }, body });
    expect(changed.isError, changed.text).not.toBe(true); expect(JSON.parse(String(fetch.mock.calls.at(-1)![1]?.body))).toEqual(body);
  }
});
it('checks a deleted speech item by its own ID and reports its deleted state without audio', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ status: 'ok' }))
    .mockResolvedValueOnce(Response.json({ ...(wire('get_speech_history_item_by_id').response as object), state: 'deleted' }));
  const removed = await pair.callTool('elevenlabs_delete_resource', args('delete_speech_history_item'));
  expect(removed.isError, removed.text).not.toBe(true);
  const read = await pair.callTool('elevenlabs_read_resource', args('get_speech_history_item_by_id'));
  expect(data(read.text)).toMatchObject({ history_item_id: 'history_example', state: 'deleted' });
  expect(JSON.parse(read.text).artifact).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(2);
});
it('reads transcripts separately and verifies deletion by absence, never by returning the deleted transcript', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(wire('get_transcript_by_id').response))
    .mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({ detail: 'Transcript missing' }, { status: 404 }));
  const read = await pair.callTool('elevenlabs_read_resource', args('get_transcript_by_id')); expect(data(read.text)).toMatchObject({ text: 'Welcome.' });
  const removed = await pair.callTool('elevenlabs_delete_resource', args('delete_transcript_by_id')); expect(data(removed.text)).toEqual({});
  const missing = await pair.callTool('elevenlabs_read_resource', args('get_transcript_by_id')); expect(missing.isError).toBe(true);
  expect(missing.text).not.toContain('Welcome.'); expect(fetch).toHaveBeenCalledTimes(3);
});
it.each(cases.filter(row => row.profile !== 'read'))('$id names a callable verifying read before retry, without retrying or claiming no charge', async source => {
  const op = await getOperation(source.id);
  expect(op.follow_ups.length).toBeGreaterThan(0);
  for (const id of op.follow_ups) {
    const read = await getOperation(id); expect(read.profile).toBe('read'); expect(read.method).toBe('GET');
    expect(read.parameters.query.required).toEqual([]);
    for (const name of read.parameters.path.required) expect(source.args.path_params).toHaveProperty(name);
  }
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ detail: 'Synthetic failure' }, { status: 503 }));
  const result = await pair.callTool(tool(source.profile), args(source.id));
  expect(result.isError).toBe(true); for (const id of op.follow_ups) expect(result.text).toContain(id);
  expect(result.text).not.toMatch(/no charge|not charged|no credits/i); expect(fetch).toHaveBeenCalledOnce();
});
it('states the limits of history verification and non-refundable deletion', async () => {
  expect((await getOperation('get_speech_history')).effect_note).toContain('Music and sound-effect generations cannot be verified');
  expect((await getOperation('delete_speech_history_item')).effect_note).toContain('does not provide its removed audio');
  expect((await getOperation('delete_audio_isolation_history_item')).effect_note).toContain('Absence from a single page is not proof');
  for (const id of ['delete_speech_history_item', 'delete_audio_isolation_history_item', 'delete_transcript_by_id', 'remove_rules'])
    expect((await getOperation(id)).effect_reason).toContain('does not refund work already billed');
});
it('gives earlier generations in these families the same truthful retry check as their newer variants', async () => {
  expect((await getOperation('add_from_file')).check_before_retry).toBe('get_pronunciation_dictionaries_metadata');
  expect((await getOperation('audio_isolation')).check_before_retry).toBe('get_audio_isolation_history');
  for (const id of ['text_to_speech_full', 'text_to_dialogue', 'speech_to_speech_full'])
    expect((await getOperation(id)).check_before_retry).toEqual({ unavailable_reason: expect.stringContaining('Speech history may show logged work but cannot prove this result') });
});
it('treats text/plain as a saved file only when its schema declares binary bytes', () => {
  expect(isBinaryMedia('text/plain', { type: 'string', format: 'binary' })).toBe(true);
  expect(isBinaryMedia('text/plain', { type: 'string' })).toBe(false);
  expect(isBinaryMedia('text/plain')).toBe(false);
  expect(isBinaryMedia('audio/mpeg')).toBe(true);
  expect(isBinaryMedia('application/json')).toBe(false);
  expect(isBinaryMedia(null)).toBe(false);
});

const streams = ['audio_isolation_stream', 'speech_to_speech_stream', 'text_to_speech_stream', 'text_to_dialogue_stream'];
const counterparts = ['audio_isolation', 'speech_to_speech_full', 'text_to_speech_full', 'text_to_dialogue'];
it.each(streams)('%s passes raw Response.body directly to the shared writer, with unchanged bytes and equivalent final artifact receipt', async id => {
  const bytes = Buffer.from([0, 255, 128, 123, 10]), notifications: unknown[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 2)); controller.enqueue(bytes.subarray(2)); controller.close(); } }), { headers: { 'content-type': 'audio/mpeg', 'x-undeclared': 'private' } });
    vi.spyOn(response, 'json').mockRejectedValue(new Error('Raw audio must not be parsed as JSON')); return response;
  });
  const streaming = await executeApiOperation('run_job', args(id), undefined, undefined, { progressToken: 0, sendNotification: async item => { notifications.push(item); } });
  const other = counterparts[streams.indexOf(id)], plain = await executeApiOperation('run_job', { ...args(id), operation_id: other });
  expect(fs.readFileSync(streaming.artifact!.file_path)).toEqual(bytes);
  expect({ ...streaming.artifact, file_path: 'same' }).toEqual({ ...plain.artifact, file_path: 'same' });
  for (const field of ['status', 'content_type', 'data', 'effects', 'response_contract', 'message'] as const) expect(streaming[field]).toEqual(plain[field]);
  expect(streaming.metadata).toBeUndefined(); expect(notifications).toMatchObject([{ params: { _meta: { 'com.mindstone/stream': { state: 'running' } } } }, { params: { _meta: { 'com.mindstone/stream': { state: 'complete', bytes: 5 } } } }]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([...streams, 'download_speech_history_items', 'get_audio_full_from_speech_history_item', 'get_pronunciation_dictionary_version_pls'])('%s refuses unknown media with nothing written', async id => {
  const prepared = args(id), before = fs.readdirSync(workspace);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('raw', { headers: { 'content-type': 'application/octet-stream' } }));
  await expect(executeApiOperation(wire(id).profile as 'read' | 'run_job', prepared)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(fs.readdirSync(workspace)).toEqual(before); expect(fetch).toHaveBeenCalledOnce();
});
it.each(streams.flatMap(id => [false, true].map(published => ({ id, published }))))('$id retains nonempty paid output as incomplete with progress=$published', async ({ id, published }) => {
  let count = 0; const bytes = Buffer.from([0, 128, 255]), notifications: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) { if (count++ === 0) controller.enqueue(bytes); else controller.error(new Error('Synthetic failure')); } }), { headers: { 'content-type': 'audio/mpeg' } }));
  const context = published ? { progressToken: 0, sendNotification: async (item: unknown) => { notifications.push(item); } } : undefined;
  const error = await executeApiOperation('run_job', args(id), undefined, undefined, context).catch(error => error);
  expect(error.retained_output).toMatchObject({ state: 'incomplete', size_bytes: 3, media_type: 'audio/mpeg' });
  expect(fs.readFileSync(error.retained_output.file_path)).toEqual(bytes);
  expect(error.message).not.toMatch(/no charge|not charged/i); if (published) expect(notifications.at(-1)).toMatchObject({ params: { _meta: { 'com.mindstone/stream': { state: 'incomplete' } } } });
});
it.each(['get_audio_full_from_speech_history_item', 'download_speech_history_items', 'get_pronunciation_dictionary_version_pls'].flatMap(id => [false, true].map(published => ({ id, published }))))('$id applies the shared published-prefix rule with progress=$published', async ({ id, published }) => {
  const source = wire(id), bytes = Buffer.from([0, 128, 255]); let count = 0;
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) { if (count++ === 0) controller.enqueue(bytes); else controller.error(new Error('Synthetic failure')); } }), { headers: { 'content-type': source.media! } }));
  const context = published ? { progressToken: 0, sendNotification: async () => {} } : undefined;
  const error = await executeApiOperation('read', args(id), undefined, undefined, context).catch(error => error);
  if (published) { expect(error.retained_output).toMatchObject({ state: 'incomplete', size_bytes: 3 }); expect(fs.readFileSync(error.retained_output.file_path)).toEqual(bytes); }
  else { expect(error.retained_output).toBeUndefined(); expect(fs.readdirSync(workspace)).toEqual([]); }
});
it.each(streams)('%s keeps a finished file complete after a later receipt failure', async id => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('finished', { headers: { 'content-type': 'audio/mpeg' } }));
  vi.spyOn(validation, 'createSuccessReceipt').mockRejectedValueOnce(new Error('Synthetic receipt failure'));
  const error = await executeApiOperation('run_job', args(id)).catch(error => error);
  expect(error.retained_outputs).toMatchObject([{ state: 'complete', size_bytes: 8 }]);
  expect(fs.readFileSync(error.retained_outputs[0].file_path, 'utf8')).toBe('finished');
});
it.each(['audio_isolation_stream', 'speech_to_speech_stream'])('%s retains exact-operand upload authorization and standalone containment', async id => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'supporting-outside-'));
  try {
    const file_path = path.join(outside, 'source.wav'); fs.writeFileSync(file_path, 'audio');
    const input = { ...args(id), files: [{ field: 'audio', file_path }] };
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }));
    expect((await pair.callTool('elevenlabs_run_job', input)).isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
    await pair.close(); pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
    const call = (reads: unknown[]) => pair.client.callTool({ name: 'elevenlabs_run_job', arguments: input, _meta: { 'files/readMode': { version: 1, mode: 'central', reads } } });
    expect((await call([])).isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
    expect((await call([{ location: ['files', 0, 'file_path'], rawPath: file_path, canonicalPath: fs.realpathSync(file_path) }])).isError).not.toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockClear(); expect((await pair.callTool('elevenlabs_run_job', { operation_id: id, ...wire(id).args, body: { audio: file_path } })).isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
it('keeps all legacy definitions unchanged', async () => {
  const tools = (await pair.client.listTools()).tools;
  expect(tools.filter(tool => legacy.some(old => old.name === tool.name)).sort((a, b) => a.name.localeCompare(b.name))).toEqual(legacy);
});

it('preserves the curated history, usage and pronunciation handlers and their receipt shapes', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const route = new URL(String(url)).pathname;
    if (route.endsWith('/audio')) return new Response('legacy audio', { headers: { 'content-type': 'audio/mpeg' } });
    if (route.endsWith('/history')) return Response.json(mockHistory);
    if (route.endsWith('/usage-by-product-over-time')) { expect(options?.method).toBe('POST'); return Response.json(mockWorkspaceUsage); }
    if (route.endsWith('/add-from-rules')) { expect(JSON.parse(String(options?.body)).description).toBe('Legacy description'); return Response.json(mockAddPronunciationDictionary); }
    if (route.endsWith('/pd-001')) {
      if (options?.method === 'PATCH') expect(JSON.parse(String(options.body))).toEqual({ archived: true });
      return Response.json(mockPronunciationDictionaryDetail);
    }
    if (route.endsWith('/pronunciation-dictionaries')) return Response.json(mockPronunciationDictionaryList);
    throw new Error('Unexpected legacy request');
  });
  const list = await pair.callTool('list_history', { page_size: 2, search: 'Acme' });
  expect(JSON.parse(list.text)).toMatchObject({ ok: true, count: 1, items: [{ history_item_id: 'hist-item-001', characters_used: 42 }], cost: 'FREE — read only' });
  expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('page_size')).toBe('2');
  const audio = await pair.callTool('get_history_item_audio', { history_item_id: 'hist-item-001' });
  expect(JSON.parse(audio.text)).toMatchObject({ ok: true, history_item_id: 'hist-item-001', cost: 'FREE — download only' });
  expect(fs.readFileSync(JSON.parse(audio.text).file_path, 'utf8')).toBe('legacy audio');
  const usage = await pair.callTool('get_usage_stats', { days_back: 7, interval: 'day', group_by: 'product_type' });
  expect(JSON.parse(usage.text)).toMatchObject({ ok: true, row_count: 3, total_credits_used: 245.8 });
  const dictionaries = await pair.callTool('list_pronunciation_dictionaries', { include_archived: true });
  expect(JSON.parse(dictionaries.text)).toMatchObject({ ok: true, dictionaries: [{ id: 'pd-001', archived: false }] });
  const dictionary = await pair.callTool('get_pronunciation_dictionary', { pronunciation_dictionary_id: 'pd-001' });
  expect(JSON.parse(dictionary.text)).toMatchObject({ ok: true, latest_version_id: 'pd-001-v1', rules: [{ type: 'alias' }] });
  const created = await pair.callTool('add_pronunciation_dictionary', { name: 'Brand terms', description: 'Legacy description', rules: [{ type: 'alias', string_to_replace: 'Acme', alias: 'Ack me' }] });
  expect(JSON.parse(created.text)).toMatchObject({ ok: true, id: 'pd-002', cost: 'FREE — metadata write only' });
  const archived = await pair.callTool('archive_pronunciation_dictionary', { pronunciation_dictionary_id: 'pd-001' });
  expect(JSON.parse(archived.text)).toMatchObject({ ok: true, pronunciation_dictionary_id: 'pd-001', cost: 'FREE — metadata write only' });
  expect(fetch).toHaveBeenCalledTimes(7);
});
