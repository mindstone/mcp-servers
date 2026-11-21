import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import * as auth from '../src/auth.js';
import { getOperation } from '../src/api-catalog.js';
import { executeApiOperation } from '../src/api-executor.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import cases from './fixtures/api-legacy-dubbing-wire-cases.json' with { type: 'json' };
import legacyTools from './fixtures/legacy-tools.json' with { type: 'json' };

vi.mock('fs', async original => ({ ...await original<typeof import('fs')>() }));
let workspace: string, pair: McpTestClient;
const wire = (id: string) => cases.find(row => row.id === id)!;
const tool = (profile: string) => profile === 'run_job' ? 'elevenlabs_run_job' : `elevenlabs_${profile}_resource`;
const data = (result: { text: string }) => JSON.parse(unwrapUntrusted(JSON.parse(result.text).data));
beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-dubbing-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace); auth.setApiKey('test-key-1');
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => {
  await pair.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); auth.setApiKey('');
  fs.rmSync(workspace, { recursive: true, force: true });
});
const uploadFields = ['file', 'csv_file', 'foreground_audio_file', 'background_audio_file'];
function filesIn(root: string) {
  return uploadFields.map((field, index) => {
    const file_path = path.join(root, ['source.mp4', 'script.csv', 'foreground.wav', 'background.mp3'][index]);
    fs.writeFileSync(file_path, index === 1 ? 'speaker,start,end,text\r\nNarrator,0,2,"Hello, there"\r\n' : Buffer.from([0, 128, 255, index]));
    return { field, file_path };
  });
}
it('streams all four optional file fields with unchanged CSV bytes and exact media types', async () => {
  const files = filesIn(workspace), source = wire('create_dubbing'), forms: FormData[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    expect(String(url)).toBe('https://api.elevenlabs.io/v1/dubbing'); expect(options?.method).toBe('POST'); expect(options?.redirect).toBe('manual');
    forms.push(await new Request(String(url), options as RequestInit).formData()); return Response.json(source.response);
  });
  const result = await pair.callTool('elevenlabs_run_job', { operation_id: source.id, ...source.args, files });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual(source.response); expect(fetch).toHaveBeenCalledOnce();
  for (const [index, operand] of files.entries()) {
    const file = forms[0].get(operand.field) as File;
    expect(file.type).toBe(['video/mp4', 'text/csv', 'audio/wav', 'audio/mpeg'][index]);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(fs.readFileSync(operand.file_path));
  }
  expect(forms[0].get('mode')).toBe('manual'); expect(forms[0].get('csv_fps')).toBe('24');
  expect(forms[0].get('disable_voice_cloning')).toBe('true'); expect(forms[0].has('target_accent')).toBe(false);
});
it('authorizes every exact file operand and enforces standalone containment and CSV type', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-authorized-'));
  try {
    const files = filesIn(outside), args = { operation_id: 'create_dubbing', body: { target_lang: 'es' }, files };
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(wire('create_dubbing').response));
    expect((await pair.callTool('elevenlabs_run_job', args)).isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
    await pair.close(); pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
    const reads = files.map((file, index) => ({ location: ['files', index, 'file_path'], rawPath: file.file_path, canonicalPath: fs.realpathSync(file.file_path) }));
    const call = (allowed: typeof reads) => pair.client.callTool({ name: 'elevenlabs_run_job', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: allowed } } });
    for (let missing = 0; missing < 4; missing++) expect((await call(reads.filter((_, index) => index !== missing))).isError).toBe(true);
    expect((await call(reads.map(read => ({ ...read, location: ['files', 0, 'file_path'] })))).isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
    expect((await call(reads)).isError).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
    fetch.mockClear(); await pair.close(); pair = await createInMemoryTestClient({ createServer });
    const wrong = path.join(workspace, 'script.json'); fs.writeFileSync(wrong, '{}');
    expect((await pair.callTool('elevenlabs_run_job', { operation_id: 'create_dubbing', files: [{ field: 'csv_file', file_path: wrong }] })).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
it.each(uploadFields)('keeps optional %s null/omission out of multipart and rejects hidden paths in the body', async field => {
  const forms: FormData[] = [], fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    forms.push(await new Request(String(url), options as RequestInit).formData()); return Response.json(wire('create_dubbing').response);
  });
  for (const files of [undefined, [{ field, file_path: null }]]) {
    expect((await pair.callTool('elevenlabs_run_job', { operation_id: 'create_dubbing', body: { source_url: 'https://example.com/source.mp4', target_lang: null }, ...(files ? { files } : {}) })).isError).not.toBe(true);
  }
  expect(forms.every(form => !form.has(field) && !form.has('target_lang'))).toBe(true);
  fetch.mockClear(); const open = vi.spyOn(fs.promises, 'open'), key = vi.spyOn(auth, 'getApiKey');
  expect((await pair.callTool('elevenlabs_run_job', { operation_id: 'create_dubbing', body: { [field]: '/outside/hidden.mp3' } })).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
});
it.each(['translate', 'dub'])('%s preserves selective arrays, required nullable languages and empty selections', async id => {
  const bodies: unknown[] = [], fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return Response.json({ version: 8 }); });
  for (const body of [{ segments: ['segment_second', 'segment_first'], languages: ['fr', 'es'] }, { segments: [], languages: null }]) {
    const result = await pair.callTool('elevenlabs_change_resource', { operation_id: id, path_params: { dubbing_id: 'dub_example' }, body });
    expect(result.isError, result.text).not.toBe(true); expect(bodies.at(-1)).toEqual(body);
  }
  fetch.mockClear();
  expect((await pair.callTool('elevenlabs_change_resource', { operation_id: id, path_params: { dubbing_id: 'dub_example' }, body: { segments: [] } })).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['update_segment_language', 'update_speaker', 'create_speaker'])('%s preserves nulls, omission and clone/library settings', async id => {
  const bodies: unknown[] = [], fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return Response.json(wire(id).response); });
  const values = id === 'update_segment_language' ? [{}, { text: null, start_time: null, end_time: null }]
    : [{}, { speaker_name: null, voice_id: 'clip-clone', voice_stability: null, voice_similarity: 0.75, voice_style: null }, { voice_id: 'voice_library_example' }, { voice_id: 'track-clone' }];
  for (const body of values) expect((await pair.callTool('elevenlabs_change_resource', { operation_id: id, path_params: wire(id).args.path_params, body })).isError).not.toBe(true);
  expect(bodies).toEqual(values); expect(fetch).toHaveBeenCalledTimes(values.length);
});
it.each(['update_speaker', 'create_speaker'])('%s says its check-before-retry read cannot show tuning values', async id => {
  const note = (await getOperation(id)).effect_note;
  expect(note).toContain('shows the version, name and voice, not the stability, similarity or style values');
});
it('distinguishes implicit work, asynchronous rendering and original automatic downloads in discovery', async () => {
  expect((await getOperation('transcribe')).effect_reason).toContain('without translating or dubbing');
  expect((await getOperation('translate')).effect_reason).toContain('transcribe missing source text');
  expect((await getOperation('translate')).effect_reason).toContain('without regenerating dubs');
  expect((await getOperation('dub')).effect_reason).toContain('transcribe and translate missing parts');
  const render = await getOperation('render'); expect(render.effect_reason).toContain('Asynchronously'); expect(render.effect_reason).toContain('segments not yet dubbed will be omitted');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(wire('render').response));
  const result = await pair.callTool('elevenlabs_change_resource', { operation_id: 'render', ...wire('render').args });
  expect(data(result)).toEqual({ version: 8, render_id: 'render_new' }); expect(JSON.parse(result.text).next_step).toContain('get_dubbing_resource'); expect(fetch).toHaveBeenCalledOnce();
  const original = await getOperation('get_dubbed_file'); expect(original.effect_reason).toContain('original automatic dub'); expect(original.effect_note).toContain('explicitly request render');
});
it.each(['audio/mpeg', 'video/mp4'])('streams original %s bytes using the shared extension table and ignores filenames and undeclared headers', async media => {
  const bytes = Buffer.from([0, 128, 255, 10]);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': media, 'content-disposition': 'attachment; filename="../../edited.exe"', 'x-undeclared': 'private' } }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_dubbed_file', ...wire('get_dubbed_file').args });
  expect(result.isError, result.text).not.toBe(true); const receipt = JSON.parse(result.text);
  expect(receipt.response_contract).toBe('matched'); expect(receipt.artifact.media_type).toBe(media); expect(path.extname(receipt.artifact.file_path)).toBe(media === 'audio/mpeg' ? '.mp3' : '.mp4');
  expect(fs.readFileSync(receipt.artifact.file_path)).toEqual(bytes); expect(path.dirname(receipt.artifact.file_path)).toBe(workspace);
  expect(receipt.metadata).toBeUndefined(); expect(result.text).not.toContain('edited.exe'); expect(fetch).toHaveBeenCalledOnce();
});
it.each(['srt', 'webvtt'])('preserves declared %s subtitle text and JSON strings without inventing a media type', async format_type => {
  const text = format_type === 'srt' ? '1\n00:00:00,000 --> 00:00:02,000\nHola.\n' : 'WEBVTT\n\n00:00.000 --> 00:02.000\nHola.\n';
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const media of ['text/plain', 'application/json']) {
    fetch.mockResolvedValueOnce(new Response(media === 'application/json' ? JSON.stringify(text) : text, { headers: { 'content-type': media } }));
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_dubbed_transcript_file', path_params: { dubbing_id: 'dub_example', language_code: 'es' }, query_params: { format_type } });
    expect(result.isError, result.text).not.toBe(true); expect(JSON.parse(result.text).response_contract).toBe('matched');
    expect(media === 'application/json' ? data(result) : unwrapUntrusted(JSON.parse(result.text).data)).toBe(text);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each(cases)('$id exposes its deprecation without rewriting its route or dispatching during discovery', async source => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const result = await pair.callTool('elevenlabs_discover_api', { operation_id: source.id });
  expect(result.isError, result.text).not.toBe(true); expect(fetch).not.toHaveBeenCalled();
  const op = await getOperation(source.id); expect(op.deprecated).toBe(true); expect(op.rank).toBe(-10); expect(op.summary).toContain('Deprecated:');
  expect(op.effect_note).toMatch(/prefer .* for current|no direct current equivalent/);
});
it('ranks current dubbing operations before deprecated rows for an unfiltered family inspection', async () => {
  const result = await pair.callTool('elevenlabs_discover_api', { family: 'dubbing', limit: 25 });
  const listing = JSON.parse(result.text).operations;
  expect(listing.slice(0, 17).every((op: { operation_id: string }) => op.operation_id.startsWith('dubbing_'))).toBe(true);
});
it.each(cases.filter(row => row.profile !== 'read'))('$id has a verifying read on success and before retry, dispatches once on failure and makes no no-charge claim', async source => {
  const op = await getOperation(source.id), expectedRead = source.id === 'create_dubbing' ? 'list_dubs' : source.id === 'delete_dubbing' ? 'get_dubbed_metadata' : 'get_dubbing_resource';
  expect(op.follow_ups).toContain(expectedRead); expect((await getOperation(expectedRead)).profile).toBe('read');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ detail: 'Synthetic failure' }, { status: 503 }));
  const result = await pair.callTool(tool(source.profile), { operation_id: source.id, ...source.args });
  expect(result.isError).toBe(true); expect(result.text).toContain(expectedRead); expect(result.text).not.toMatch(/no charge|not charged|no credits/i); expect(fetch).toHaveBeenCalledOnce();
});
it('preserves all 32 legacy definitions and the four curated dubbing handlers despite shared operation names', async () => {
  const names = ['create_dubbing', 'get_dubbing', 'download_dubbed_audio', 'delete_dubbing'];
  const actual = (await pair.client.listTools()).tools;
  expect(actual.filter(tool => legacyTools.some(old => old.name === tool.name)).sort((a, b) => a.name.localeCompare(b.name))).toEqual(legacyTools);
  for (const name of names) expect(actual.find(tool => tool.name === name)).toEqual(legacyTools.find(tool => tool.name === name));
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const route = new URL(String(url)).pathname;
    if (options?.method === 'POST') {
      const form = options.body as FormData; expect(form.get('target_lang')).toBe('es'); expect(form.get('watermark')).toBe('false');
      expect(form.get('source_url')).toBe('https://example.com/source.mp4'); return Response.json({ dubbing_id: 'dub_example', expected_duration_sec: 4 });
    }
    if (options?.method === 'DELETE') return Response.json({ status: 'ok' });
    if (route.endsWith('/audio/es')) return new Response('original', { headers: { 'content-type': 'audio/mpeg' } });
    return Response.json(wire('get_dubbed_metadata').response);
  });
  const create = await pair.callTool('create_dubbing', { source_url: 'https://example.com/source.mp4', target_lang: 'es' });
  expect(JSON.parse(create.text)).toMatchObject({ ok: true, dubbing_id: 'dub_example', expected_duration_sec: 4, poll_hint: expect.stringContaining('get_dubbing') });
  const read = await pair.callTool('get_dubbing', { dubbing_id: 'dub_example' });
  expect(JSON.parse(read.text)).toMatchObject({ ok: true, is_terminal: true, next_step: expect.stringContaining('download_dubbed_audio') });
  const download = await pair.callTool('download_dubbed_audio', { dubbing_id: 'dub_example', language_code: 'es' });
  expect(JSON.parse(download.text)).toMatchObject({ ok: true, dubbing_id: 'dub_example', language_code: 'es', size_bytes: 8 });
  const deleted = await pair.callTool('delete_dubbing', { dubbing_id: 'dub_example' }); expect(JSON.parse(deleted.text)).toMatchObject({ ok: true, dubbing_id: 'dub_example' });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it.each(['srt', 'webvtt'])('keeps %s in the structured transcript envelope with nullable alternate representations', async format_type => {
  const response = { transcript_format: format_type, srt: format_type === 'srt' ? '1\nHola.\n' : null, webvtt: format_type === 'webvtt' ? 'WEBVTT\nHola.\n' : null, json: null };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(response));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_dubbing_transcripts', path_params: { dubbing_id: 'dub_example', language_code: 'es', format_type } });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual(response); expect(fetch).toHaveBeenCalledOnce();
});
it('refuses undeclared media without a guessed extension or redirect', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('unknown bytes', { headers: { 'content-type': 'application/octet-stream' } }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_dubbed_file', ...wire('get_dubbed_file').args });
  expect(result.isError).toBe(true); expect(fs.readdirSync(workspace)).toEqual([]); expect(fetch).toHaveBeenCalledOnce();
});
it.each([false, true])('applies the shared read partial-file rule with published progress=%s', async published => {
  const bytes = Buffer.from([0, 128, 255]), notifications: unknown[] = [];
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (chunks++ === 0) controller.enqueue(bytes); else controller.error(new Error('Synthetic stream failure')); } });
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'audio/mpeg' } }));
  const context = published ? { progressToken: 0, sendNotification: async (item: unknown) => { notifications.push(item); } } : undefined;
  const error = await executeApiOperation('read', { operation_id: 'get_dubbed_file', ...wire('get_dubbed_file').args }, undefined, undefined, context).catch(error => error);
  expect(error.code).toBe('INVALID_RESPONSE'); expect(fetch).toHaveBeenCalledOnce();
  if (published) { expect(error.retained_output).toMatchObject({ state: 'incomplete', size_bytes: 3, media_type: 'audio/mpeg' }); expect(fs.readFileSync(error.retained_output.file_path)).toEqual(bytes); expect(notifications.length).toBeGreaterThan(0); }
  else { expect(error.retained_output).toBeUndefined(); expect(fs.readdirSync(workspace)).toEqual([]); }
});
