import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import * as auth from '../src/auth.js';
import { getOperation } from '../src/api-catalog.js';
import { multipartUpload } from '../src/api-multipart.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import cases from './fixtures/api-dubbing-wire-cases.json' with { type: 'json' };

vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));
let workspace: string, pair: McpTestClient;
const wire = (id: string) => cases.find(row => row.id === id)!;
const data = (result: { text: string }) => JSON.parse(unwrapUntrusted(JSON.parse(result.text).data));
const tool = (profile: string) => profile === 'run_job' ? 'elevenlabs_run_job' : `elevenlabs_${profile}_resource`;
beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dubbing-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace); auth.setApiKey('test-key-1');
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => {
  await pair.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); auth.setApiKey('');
  fs.rmSync(workspace, { recursive: true, force: true });
});

it('keeps source media, optional JSON transcript and ordered repeated controls in one multipart request', async () => {
  const media = path.join(workspace, 'source.mp4'), transcript = path.join(workspace, 'transcript.json');
  const bytes = Buffer.from([0, 128, 255, 10, 42]), text = '{"segments":[{"external_id":"line_1","text":"Welcome.","speaker_id":"speaker_example","start_s":0,"end_s":2.5}]}';
  fs.writeFileSync(media, bytes); fs.writeFileSync(transcript, text);
  const source = wire('dubbing_project_create'), formData: FormData[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (url, options) => {
    expect(String(url)).toBe('https://api.elevenlabs.io/v1/dubbing/project');
    expect(options?.method).toBe('POST'); expect(options?.redirect).toBe('manual');
    formData.push(await new Request(String(url), options as RequestInit).formData());
    return Response.json(source.response, { status: 201 });
  });
  const result = await pair.callTool('elevenlabs_run_job', { operation_id: source.id, ...source.args, files: [{ field: 'transcript', file_path: transcript }, { field: 'file', file_path: media }] });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual(source.response); expect(fetch).toHaveBeenCalledOnce();
  const form = formData[0];
  expect([...form.keys()]).toEqual([...source.multipart!.scalars.map(([key]) => key), 'transcript', 'file']);
  expect(form.getAll('keyterms')).toEqual(['second term', 'first term', 'second term']);
  expect(form.getAll('webhook_ids')).toEqual(['webhook_second', 'webhook_first']);
  expect((form.get('transcript') as File).type).toBe('application/json'); expect(await (form.get('transcript') as File).text()).toBe(text);
  expect((form.get('file') as File).type).toBe('video/mp4'); expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(bytes);
});

it('passes URL sources to the provider without reading or fetching them, with an optional first target only when supplied', async () => {
  const source = wire('dubbing_project_create'), forms: FormData[] = [];
  const open = vi.spyOn(fs.promises, 'open');
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    expect(String(url)).toBe('https://api.elevenlabs.io/v1/dubbing/project');
    forms.push(await new Request(String(url), options as RequestInit).formData()); return Response.json(source.response, { status: 201 });
  });
  for (const target of [undefined, 'es']) {
    const result = await pair.callTool('elevenlabs_run_job', { operation_id: source.id, body: { source_url: 'https://example.com/source.mp4?token=example-token', source_language: 'en', ...(target ? { target_language: target } : {}) }, files: [{ field: 'file', file_path: null }] });
    expect(result.isError, result.text).not.toBe(true);
  }
  expect(open).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
  expect(forms.map(form => form.get('source_url'))).toEqual(Array(2).fill('https://example.com/source.mp4?token=example-token'));
  expect(forms.map(form => form.has('file'))).toEqual([false, false]);
  expect(forms.map(form => form.get('target_language'))).toEqual([null, 'es']);
  fetch.mockResolvedValueOnce(Response.json({ detail: 'https://example.com/source.mp4?token=example-token' }, { status: 400 }));
  const failure = await pair.callTool('elevenlabs_run_job', { operation_id: source.id, body: { source_url: 'https://example.com/source.mp4?token=example-token' } });
  expect(failure.isError).toBe(true); expect(failure.text).not.toContain('example-token');
});

it('requires authorization at each exact media and transcript operand and retains standalone containment', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dubbing-authorized-'));
  try {
    const media = path.join(outside, 'source.mp4'), transcript = path.join(outside, 'transcript.json');
    fs.writeFileSync(media, 'source'); fs.writeFileSync(transcript, '{"segments":[]}');
    const files = [{ field: 'file', file_path: media }, { field: 'transcript', file_path: transcript }];
    const args = { operation_id: 'dubbing_project_create', body: { source_language: 'en' }, files };
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(wire(args.operation_id).response, { status: 201 }));
    const standalone = await pair.callTool('elevenlabs_run_job', args); expect(standalone.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
    await pair.close(); pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
    const reads = files.map((file, index) => ({ location: ['files', index, 'file_path'], rawPath: file.file_path, canonicalPath: fs.realpathSync(file.file_path) }));
    const call = (allowed: typeof reads) => pair.client.callTool({ name: 'elevenlabs_run_job', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: allowed } } });
    expect((await call(reads.slice(0, 1))).isError).toBe(true);
    expect((await call(reads.map(read => ({ ...read, location: ['files', 0, 'file_path'] })))).isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
    expect((await call(reads)).isError).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

it('streams a 3 GiB media operand in bounded chunks and refuses oversized media and transcripts before dispatch', async () => {
  const op = await getOperation('dubbing_project_create'), media = path.join(workspace, 'large.mp4'), transcript = path.join(workspace, 'large.json');
  const sparse = (name: string, size: number) => { const fd = fs.openSync(name, 'w'); fs.ftruncateSync(fd, size); fs.closeSync(fd); };
  sparse(media, 3 * 1024 ** 3); sparse(transcript, 4 * 1024 ** 2);
  const handles: import('node:fs/promises').FileHandle[] = [], open = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => { const handle = await open(...args); handles.push(handle); return handle; });
  const read = vi.spyOn(fs, 'readFileSync'), controller = new AbortController();
  const upload = await multipartUpload(op, { operation_id: op.operation_id, body: { source_language: 'en' }, files: [{ field: 'file', file_path: media }, { field: 'transcript', file_path: transcript }] }, undefined, controller.signal);
  try {
    const reader = upload.body.getReader();
    let chunk = await reader.read();
    while (chunk.value && chunk.value.byteLength < 65536) chunk = await reader.read();
    expect(chunk.value!.byteLength).toBe(65536);
    controller.abort(); await expect(reader.read()).rejects.toThrow(); await reader.cancel().catch(() => {});
    expect(read).not.toHaveBeenCalled();
  } finally { await upload.close(); }
  expect(handles.every(handle => handle.fd === -1)).toBe(true);
  sparse(media, 3 * 1024 ** 3 + 1); sparse(transcript, 4 * 1024 ** 2 + 1);
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const [field, file_path] of [['file', media], ['transcript', transcript]]) {
    const result = await pair.callTool('elevenlabs_run_job', { operation_id: op.operation_id, body: { source_url: 'https://example.com/source.mp4', source_language: 'en' }, files: [{ field, file_path }] });
    expect(result.isError).toBe(true); expect(JSON.parse(result.text).code).toBe('FILE_TOO_LARGE');
  }
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['queued', 'preparing', 'ready', 'failed'])('returns project %s without polling or treating preparation as a completed target', async status => {
  const source = wire('dubbing_project_get'), response = { ...source.response as object, status };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(response));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: source.id, ...source.args });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual(response); expect(fetch).toHaveBeenCalledOnce();
});

it.each(['queued', 'processing', 'completed', 'stale', 'failed'])('returns target %s and distinct revision/output_revision without polling or fetching its signed URLs', async status => {
  const source = wire('dubbing_language_get');
  const response = status === 'stale' ? { ...source.response as object, status }
    : status === 'completed' ? { ...(wire('dubbing_language_list').response as { languages: object[] }).languages[0], status }
    : { ...wire('dubbing_language_create').response as object, status };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(response));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: source.id, ...source.args });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual(response);
  expect(data(result)).toMatchObject(status === 'stale' ? { revision: 5, output_revision: 3 } : status === 'completed' ? { revision: 3, output_revision: 3 } : { revision: 0, output_revision: null }); expect(fetch).toHaveBeenCalledOnce();
  expect(result.text).not.toContain('next_step'); expect(JSON.parse(result.text).metadata).toBeUndefined();
});

it.each(['dubbing_target_transcript_segment_update', 'dubbing_transcript_segment_update'])('%s keeps explicit nulls distinct from omitted fields', async id => {
  const source = wire(id), bodies: unknown[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return Response.json(source.response); });
  const clear = id.startsWith('dubbing_target') ? { translation: null } : { text: null, speaker_id: null, start_s: null, end_s: null };
  for (const body of [{}, clear]) {
    const result = await pair.callTool('elevenlabs_change_resource', { operation_id: id, path_params: source.args.path_params, body });
    expect(result.isError, result.text).not.toBe(true);
  }
  expect(bodies).toEqual([{}, clear]); expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['dubbing_transcript_segments_update', 'dubbing_target_transcript_segments_update'])('%s sends one atomic map and enforces pinned entry bounds before I/O', async id => {
  const source = wire(id), fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(source.response));
  const result = await pair.callTool('elevenlabs_change_resource', { operation_id: id, ...source.args });
  expect(result.isError, result.text).not.toBe(true); expect(fetch.mock.calls[0][1]?.body).toBe(JSON.stringify(source.body)); expect(fetch).toHaveBeenCalledOnce();
  fetch.mockClear(); const key = vi.spyOn(auth, 'getApiKey');
  for (const segments of [{}, Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`segment_${index}`, {}]))]) {
    const invalid = await pair.callTool('elevenlabs_change_resource', { operation_id: id, path_params: source.args.path_params, body: { segments } });
    expect(invalid.isError).toBe(true);
  }
  expect(fetch).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
});

it('states minimum prepayment, replacement regeneration and non-refundable deletion without suggesting unsolicited mutations', async () => {
  for (const id of ['dubbing_project_create', 'dubbing_language_create']) {
    const op = await getOperation(id); expect(op.profile).toBe('run_job');
    expect(op.effect_reason).toMatch(/minimum.*one.language.*charge|minimum charge of one language/);
    expect(op.effect_reason).toMatch(/prepays the first target/); expect(op.effect_reason).toContain('each additional language is charged separately');
  }
  const regen = await getOperation('dubbing_target_transcript_regenerate');
  expect(regen).toMatchObject({ profile: 'change', effects: { destructiveHint: true }, effect_reason: expect.stringContaining('replaces its output revision') });
  expect(regen.effect_reason).toContain('free-regeneration allowance');
  // Regeneration has no body: its note describes the asynchronous re-dub and the uncharged no-edits conflict.
  expect(regen.effect_note).toContain('returns to processing'); expect(regen.effect_note).toContain('nothing dispatched or charged');
  expect(regen.effect_note).not.toContain('explicit null');
  // A segment delete is checked before any retry by reading the transcript it changed, not the project list.
  expect((await getOperation('dubbing_transcript_segment_delete')).follow_ups).toEqual(['dubbing_transcript_get']);
  for (const source of cases) {
    const op = await getOperation(source.id);
    if (op.profile === 'delete') expect(op.effect_reason).toContain('does not refund work already running or billed');
    for (const id of op.follow_ups) expect((await getOperation(id)).profile).toBe('read');
  }
});

it.each(['dubbing_language_get', 'dubbing_language_list', 'dubbing_language_create'])('%s returns only declared signed URLs as data and omits them from errors and mismatch diagnostics', async id => {
  const source = wire(id), signed = 'https://example.com/output.flac?token=example-token';
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ ...source.response as object, unexpected: signed }, { status: source.status }));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await pair.callTool(tool(source.profile), { operation_id: id, ...source.args });
  expect(result.isError, result.text).not.toBe(true); expect(data(result).unexpected).toBe(signed);
  expect(JSON.stringify({ ...JSON.parse(result.text), data: undefined })).not.toContain(signed);
  fetch.mockResolvedValueOnce(Response.json({ outputs: { lossless_audio: signed } }, { status: source.status }));
  const mismatch = await pair.callTool(tool(source.profile), { operation_id: id, ...source.args });
  expect(JSON.stringify(JSON.parse(mismatch.text).response_contract)).not.toContain(signed);
  fetch.mockResolvedValueOnce(Response.json({ detail: signed }, { status: 503 }));
  const failure = await pair.callTool(tool(source.profile), { operation_id: id, ...source.args });
  expect(failure.isError).toBe(true); expect(failure.text).not.toContain(signed); expect(failure.text).not.toContain('example-token');
  expect(JSON.stringify(log.mock.calls)).not.toContain(signed); expect(fetch).toHaveBeenCalledTimes(3);
  expect(fs.readdirSync(workspace)).toEqual([]);
});

it.each(cases.filter(source => source.profile !== 'read'))('$id failure dispatches once, makes no charge claim, and never retries, polls or starts an extra mutation', async source => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ detail: 'Synthetic failure' }, { status: 503 }));
  const result = await pair.callTool(tool(source.profile), { operation_id: source.id, ...source.args });
  expect(result.isError).toBe(true); expect(result.text).not.toMatch(/no charge|not charged|no credits/i); expect(fetch).toHaveBeenCalledOnce();
});
