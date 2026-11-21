import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { http, HttpResponse } from 'msw';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import { setApiKey } from '../src/auth.js';
import { executeApiOperation } from '../src/api-executor.js';
import { getOperation } from '../src/api-catalog.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import { mswServer } from './helpers/setup.js';
import cases from './fixtures/api-studio-wire-cases.json' with { type: 'json' };
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';

let workspace: string, pair: McpTestClient;
const reads = cases.filter(row => row.profile === 'read');
const writes = cases.filter(row => row.profile !== 'read');
const downloads = reads.filter(row => row.media !== 'application/json');
const args = (row: typeof cases[number]) => ({ operation_id: row.id, ...row.args });
beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace); setApiKey('synthetic-studio-key');
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => {
  await pair.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setApiKey('');
  fs.rmSync(workspace, { recursive: true, force: true });
});

it.each(reads)('$id preserves its literal wire contract, effects and result through the SDK', async row => {
  const requests: Request[] = [];
  const bytes = row.bytes_base64 ? Buffer.from(row.bytes_base64, 'base64') : undefined;
  mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => {
    requests.push(request);
    const url = new URL(request.url);
    expect(request.method).toBe(row.method); expect(url.pathname).toBe(row.path);
    expect([...url.searchParams]).toEqual(row.query);
    expect(await request.text()).toBe(row.body === undefined ? '' : JSON.stringify(row.body));
    expect(request.headers.get('xi-api-key')).toBe('synthetic-studio-key');
    expect(request.redirect).toBe('manual');
    return new HttpResponse(bytes ?? JSON.stringify(row.response), { status: row.status, headers: {
      'content-type': row.media, 'content-disposition': 'attachment; filename="../../provider.exe"',
    } });
  }));
  const result = await pair.callTool('elevenlabs_read_resource', args(row));
  expect(result.isError, result.text).not.toBe(true); expect(requests).toHaveLength(1);
  const receipt = JSON.parse(result.text);
  expect(receipt).toMatchObject({ status: 200, content_type: row.media, response_contract: 'matched', effects: {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  } });
  if (bytes) {
    expect(receipt.artifact).toMatchObject({ media_type: row.media, size_bytes: bytes.length });
    expect(path.extname(receipt.artifact.file_path)).toBe(row.media === 'audio/mpeg' ? '.mp3' : '.zip');
    expect(path.dirname(receipt.artifact.file_path)).toBe(workspace);
    expect(fs.readFileSync(receipt.artifact.file_path)).toEqual(bytes);
    expect(fs.readdirSync(workspace)).toEqual([path.basename(receipt.artifact.file_path)]);
    expect(result.text).not.toContain('provider.exe');
  } else {
    expect(JSON.parse(unwrapUntrusted(receipt.data))).toEqual(row.response);
    expect(fs.readdirSync(workspace)).toEqual([]);
  }
  const op = await getOperation(row.id);
  expect(op.timeout).toBe(bytes ? 'long' : 'standard');
  expect(op.follow_ups).toEqual([]); expect(op.retry_check).toBeUndefined();
  expect(op.effect_note).toContain('Repeat the same');
});

it.each([undefined, {}, { convert_to_mpeg: false }, { convert_to_mpeg: true }])('preserves optional chapter stream body %j without inserting defaults', async body => {
  const row = downloads.find(row => row.id === 'stream_chapter_snapshot_audio')!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.from(row.bytes_base64!, 'base64'), { headers: { 'content-type': 'audio/mpeg' } }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: row.id, path_params: row.args.path_params, ...(body === undefined ? {} : { body }) });
  expect(result.isError, result.text).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][1]?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
  expect(JSON.parse(result.text).artifact.media_type).toBe('audio/mpeg');
});

it('omits null or absent share queries while preserving returned public share identifiers', async () => {
  const row = cases.find(row => row.id === 'get_project_by_id')!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(row.response));
  for (const query_params of [undefined, {}, { share_id: null }]) {
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id: row.id, path_params: row.args.path_params, query_params });
    expect(result.isError, result.text).not.toBe(true);
    expect(new URL(String(fetch.mock.calls.at(-1)![0])).search).toBe('');
    expect(JSON.parse(unwrapUntrusted(JSON.parse(result.text).data)).public_share_id).toBe('share_example');
  }
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(downloads.flatMap(row => ['application/octet-stream', 'application/zip', 'audio/wav'].map(media => ({ row, media }))))('$row.id refuses undeclared $media before writing', async ({ row, media }) => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.from(row.bytes_base64!, 'base64'), { headers: { 'content-type': media } }));
  const result = await pair.callTool('elevenlabs_read_resource', args(row));
  expect(result.isError).toBe(true); expect(result.text).toContain('INVALID_RESPONSE');
  expect(fs.readdirSync(workspace)).toEqual([]); expect(fetch).toHaveBeenCalledOnce();
});

it.each(downloads.flatMap(row => [false, true].map(published => ({ row, published }))))('$row.id preserves the shared interrupted-stream rule with progress=$published', async ({ row, published }) => {
  const bytes = Buffer.from(row.bytes_base64!, 'base64').subarray(0, 7);
  let count = 0; const notifications: unknown[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ pull(controller) {
    if (count++ === 0) controller.enqueue(bytes); else controller.error(new Error('Synthetic interruption'));
  } }), { headers: { 'content-type': row.media } }));
  const context = published ? { progressToken: 0, sendNotification: async (item: unknown) => { notifications.push(item); } } : undefined;
  const error = await executeApiOperation('read', args(row), undefined, undefined, context).catch(error => error);
  if (published) {
    expect(error.retained_output).toMatchObject({ size_bytes: bytes.length, media_type: row.media, state: 'incomplete' });
    expect(fs.readFileSync(error.retained_output.file_path)).toEqual(bytes);
    expect(fs.readdirSync(workspace)).toEqual([path.basename(error.retained_output.file_path)]);
    expect(notifications.at(-1)).toMatchObject({ params: { _meta: { 'com.mindstone/stream': { state: 'incomplete' } } } });
  } else {
    expect(error.retained_output).toBeUndefined(); expect(fs.readdirSync(workspace)).toEqual([]);
  }
  expect(error.resolution).toContain(`Check the result with ${row.id}`);
  expect(error.resolution).not.toContain('get_project_snapshot_endpoint');
  expect(error.resolution).not.toContain('get_chapter_snapshot_endpoint');
  expect(fetch).toHaveBeenCalledOnce();
});

it('rejects invalid optional bodies and bodyless archive arguments without dispatch', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const body of [null, { convert_to_mpeg: 'false' }]) {
    const row = downloads.find(row => row.id === 'stream_chapter_snapshot_audio')!;
    expect((await pair.callTool('elevenlabs_read_resource', { ...args(row), body })).isError).toBe(true);
  }
  const row = downloads.find(row => row.id === 'stream_project_snapshot_archive_endpoint')!;
  expect((await pair.callTool('elevenlabs_read_resource', { ...args(row), body: {} })).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

const tool = (profile: string) => `elevenlabs_${profile}_resource`;
const data = (text: string) => JSON.parse(unwrapUntrusted(JSON.parse(text).data));
const write = (id: string) => writes.find(row => row.id === id)!;
it.each(writes)('$id declares independent retry reads and follow-ups, including uncertain dispatch', async row => {
  const op = await getOperation(row.id);
  expect(op.follow_ups).toEqual(row.follow_ups);
  if (row.retry_read === 'unavailable') {
    expect(op.retry_check).toMatchObject({ unavailable_reason: expect.stringContaining('get_chapters') });
    expect(op.retry_check).toMatchObject({ unavailable_reason: expect.stringContaining('get_chapter_by_id_endpoint') });
  } else expect(op.retry_check).toBe(row.retry_read);
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Synthetic connection loss'));
  const result = await pair.callTool(tool(row.profile), args(row));
  expect(result.isError).toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(result.text).toContain(row.retry_read === 'unavailable' ? 'No verifiable lookup' : row.retry_read!);
  expect(result.text).toContain('No automatic retry');
  expect(op.effect_note).toMatch(/retry|repeat|Read|Check/);
  if (row.profile === 'delete') expect(op.effect_reason).toContain('does not refund');
});

it.each(['convert_chapter_endpoint', 'convert_project_endpoint'])('%s reports acceptance and requires an explicit snapshot read', async id => {
  const row = write(id); const snapshot = reads.find(item => item.id === row.retry_read)!;
  let converted = false; let finished = false; const calls: string[] = [];
  mswServer.use(http.all('https://api.elevenlabs.io/*', ({ request }) => {
    const route = new URL(request.url).pathname; calls.push(route);
    if (route === row.path) { converted = true; return HttpResponse.json({ status: 'ok' }); }
    expect(route).toBe(snapshot.path);
    return HttpResponse.json(finished ? snapshot.response : { snapshots: [] });
  }));
  const result = await pair.callTool(tool(row.profile), args(row));
  expect(result.isError, result.text).not.toBe(true); expect(converted).toBe(true);
  expect(data(result.text)).toEqual({ status: 'ok' });
  expect(JSON.parse(result.text)).toMatchObject({ message: 'The provider returned a success response.', follow_up_operations: [snapshot.id], next_step: expect.stringContaining(snapshot.id) });
  expect(calls).toEqual([row.path]);
  const discovered = await pair.callTool('elevenlabs_discover_api', { operation_id: id });
  expect(discovered.text).toContain('Acceptance is not a finished snapshot');
  expect(discovered.text).toContain('Do not repeat conversion');
  expect(data((await pair.callTool('elevenlabs_read_resource', args(snapshot))).text)).toEqual({ snapshots: [] });
  finished = true;
  expect(data((await pair.callTool('elevenlabs_read_resource', args(snapshot))).text)).toEqual(snapshot.response);
  expect(calls).toEqual([row.path, snapshot.path, snapshot.path]);
});

it('reads exact replacement chapter content after a project content edit', async () => {
  const row = write('edit_project_content'); const chapter = write('edit_chapter').response;
  const list = reads.find(item => item.id === 'get_chapters')!;
  const detail = reads.find(item => item.id === 'get_chapter_by_id_endpoint')!;
  const calls: string[] = [];
  mswServer.use(http.all('https://api.elevenlabs.io/*', ({ request }) => {
    const route = new URL(request.url).pathname; calls.push(route);
    if (route === row.path) return HttpResponse.json(row.response);
    if (route === list.path) return HttpResponse.json(list.response);
    expect(route).toBe(detail.path);
    return HttpResponse.json('chapter' in chapter ? chapter.chapter : {});
  }));
  const edited = await pair.callTool(tool(row.profile), args(row));
  expect(edited.isError, edited.text).not.toBe(true);
  expect(JSON.parse(edited.text).follow_up_operations).toEqual(['get_chapters', 'get_chapter_by_id_endpoint']);
  expect((await pair.callTool('elevenlabs_read_resource', args(list))).isError).not.toBe(true);
  const result = await pair.callTool('elevenlabs_read_resource', args(detail));
  expect(result.isError, result.text).not.toBe(true);
  expect(data(result.text).content).toEqual('chapter' in chapter ? chapter.chapter.content : undefined);
  expect(data(result.text).content.blocks.flatMap((block: { nodes: { text: string }[] }) => block.nodes.map(node => node.text))).toEqual(['Acme Guide', 'Exact replacement text.']);
  expect(calls).toEqual([row.path, list.path, detail.path]);
});

it('keeps content block schemas, required edit voices and from_content_json distinct', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const edit = write('edit_project');
  for (const missing of ['default_title_voice_id', 'default_paragraph_voice_id']) {
    const body: Record<string, unknown> = { ...edit.args.body }; delete body[missing];
    expect((await pair.callTool(tool(edit.profile), { ...args(edit), body })).isError).toBe(true);
  }
  for (const content of [{}, { blocks: [{ nodes: [{ type: 'tts_node', text: 'Missing voice' }] }] }, { blocks: [{ sub_type: 'invalid', nodes: [] }] }, { blocks: [{ nodes: [{ type: 'audio_node', voice_id: 'voice_example', text: 'Wrong type' }] }] }]) {
    const row = write('edit_chapter');
    expect((await pair.callTool(tool(row.profile), { ...args(row), body: { content } })).isError).toBe(true);
  }
  const row = write('edit_project_content');
  expect((await pair.callTool(tool(row.profile), { ...args(row), body: { from_content_json: {} } })).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it('replaces dictionary locators, including clearing the set, and reads the resulting versions', async () => {
  const row = write('update_pronunciation_dictionaries');
  const project = reads.find(item => item.id === 'get_project_by_id')!;
  let locators: unknown[] = []; const calls: string[] = [];
  mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => {
    const route = new URL(request.url).pathname; calls.push(route);
    if (route === row.path) {
      const body = await request.json() as { pronunciation_dictionary_locators: unknown[]; invalidate_affected_text: boolean };
      locators = body.pronunciation_dictionary_locators;
      expect(body.invalidate_affected_text).toBe(true);
      return HttpResponse.json({ status: 'ok' });
    }
    expect(route).toBe(project.path);
    return HttpResponse.json({ ...project.response, pronunciation_dictionary_locators: locators });
  }));
  for (const expected of [row.args.body?.pronunciation_dictionary_locators, []]) {
    const result = await pair.callTool(tool(row.profile), { ...args(row), body: { pronunciation_dictionary_locators: expected, invalidate_affected_text: true } });
    expect(result.isError, result.text).not.toBe(true);
    expect(JSON.parse(result.text).next_step).toContain('get_project_by_id');
    const read = await pair.callTool('elevenlabs_read_resource', args(project));
    expect(read.isError, read.text).not.toBe(true);
    expect(data(read.text).pronunciation_dictionary_locators).toEqual(expected);
  }
  expect(calls).toEqual([row.path, project.path, row.path, project.path]);
  expect((await getOperation(row.id)).effect_reason).toContain('Replaces the project dictionary set');
});

it.each(['add_chapter', 'add_project', 'edit_project_content'])('%s hides submitted URL credentials in success and errors without fetching URLs', async id => {
  const row = write(id);
  const secret = 'https://reader:synthetic-url-password@docs.example.com/article?credential=synthetic';
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const field of id === 'add_project' ? ['from_url', 'callback_url'] : ['from_url']) {
    for (const failed of [false, true]) {
      fetch.mockResolvedValueOnce(Response.json(failed ? { detail: { message: secret + ' ' + encodeURIComponent(secret) } } : { ...row.response, diagnostic: secret }, { status: failed ? 400 : 200 }));
      const result = await pair.callTool(tool(row.profile), { ...args(row), body: { ...row.args.body, [field]: secret } });
      expect(Boolean(result.isError)).toBe(failed);
      for (const value of [secret, encodeURIComponent(secret), 'synthetic-url-password']) expect(result.text).not.toContain(value);
    }
  }
  expect(fetch).toHaveBeenCalledTimes(id === 'add_project' ? 4 : 2);
  for (const [url] of fetch.mock.calls) expect(String(url)).toBe(`https://api.elevenlabs.io${row.path}`);
});

it.each(['add_project', 'edit_project_content'])('%s requires authorization for its exact document operand through the SDK', async id => {
  await pair.close(); pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  const row = write(id); const source = path.join(workspace, 'guide.txt'); fs.writeFileSync(source, 'Acme document');
  const requests: string[] = [];
  mswServer.use(http.post(`https://api.elevenlabs.io${row.path}`, async ({ request }) => {
    requests.push(await ((await request.formData()).get('from_document') as File).text());
    return HttpResponse.json(row.response);
  }));
  const input = { ...args(row), files: [{ field: 'from_document', file_path: source }] };
  for (const reads of [[], [{ location: ['files', 1, 'file_path'], rawPath: source, canonicalPath: source }]]) {
    expect((await pair.client.callTool({ name: tool(row.profile), arguments: input, _meta: { 'files/readMode': { version: 1, mode: 'central', reads } } })).isError).toBe(true);
  }
  expect(requests).toEqual([]);
  const result = await pair.client.callTool({ name: tool(row.profile), arguments: input, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['files', 0, 'file_path'], rawPath: source, canonicalPath: source }] } } });
  expect(result.isError, JSON.stringify(result)).not.toBe(true); expect(requests).toEqual(['Acme document']);
});
