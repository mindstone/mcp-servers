import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { http, HttpResponse } from 'msw';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import { setApiKey } from '../src/auth.js';
import { getOperation } from '../src/api-catalog.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import { readSandboxedFile } from '../src/tools/file-input.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
import { mswServer } from './helpers/setup.js';
import cases from './fixtures/api-audio-native-wire-cases.json' with { type: 'json' };

let workspace: string, pair: McpTestClient;
const args = (row: typeof cases[number]) => ({ operation_id: row.id, ...row.args });
const tool = (profile: string) => profile === 'run_job' ? 'elevenlabs_run_job' : `elevenlabs_${profile}_resource`;
const data = (text: string) => JSON.parse(unwrapUntrusted(JSON.parse(text).data));
const podcast = cases.find(row => row.id === 'create_podcast')!;
const uploads = cases.filter(row => row.multipart);
const writes = cases.filter(row => row.profile !== 'read');
beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audio-native-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace); setApiKey('synthetic-audio-native-key');
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => {
  await pair.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setApiKey('');
  fs.rmSync(workspace, { recursive: true, force: true });
});

const modes = [
  { type: 'conversation', conversation: { host_voice_id: 'voice_host', guest_voice_id: 'voice_guest' } },
  { type: 'bulletin', bulletin: { host_voice_id: 'voice_host' } },
];
const sources = [
  { type: 'text', text: 'Acme article' },
  { type: 'url', url: 'https://docs.example.com/article' },
  [{ type: 'text', text: 'First article' }, { type: 'text', text: 'Second article' }],
  [{ type: 'url', url: 'https://docs.example.com/first' }, { type: 'url', url: 'https://docs.example.com/second' }],
  [{ type: 'text', text: 'Acme article' }, { type: 'url', url: 'https://docs.example.com/article' }],
];
it.each(modes.flatMap(mode => sources.map(source => ({ mode, source }))))('preserves podcast $mode.type with source $source and omits moderation headers', async ({ mode, source }) => {
  const body = { ...podcast.args.body, mode, source };
  const observed: Request[] = [];
  mswServer.use(http.post('https://api.elevenlabs.io/v1/studio/podcasts', async ({ request }) => {
    observed.push(request);
    expect(await request.json()).toEqual(body);
    expect(request.headers.get('safety-identifier')).toBeNull();
    expect(request.headers.get('xi-workspace-id')).toBeNull();
    expect(request.headers.get('xi-api-key')).toBe('synthetic-audio-native-key');
    expect(request.redirect).toBe('manual');
    return HttpResponse.json(podcast.response);
  }));
  const result = await pair.callTool(tool(podcast.profile), { ...args(podcast), body });
  expect(result.isError, result.text).not.toBe(true); expect(observed).toHaveLength(1);
  expect(data(result.text)).toEqual(podcast.response);
  expect(JSON.parse(result.text).effects).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  expect(JSON.parse(result.text).follow_up_operations).toEqual(['get_project_by_id', 'get_project_snapshots']);
  const discovered = await pair.callTool('elevenlabs_discover_api', { operation_id: podcast.id });
  expect(discovered.text).toContain('safety-identifier');
  expect(discovered.text).toContain('intentionally omitted');
  expect(discovered.text).toContain('Acceptance is not finished audio');
});

it('refuses malformed podcast branches and caller-controlled headers before any request', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const body of [
    { mode: { type: 'conversation', conversation: { host_voice_id: 'voice_host' } } },
    { mode: { type: 'bulletin', bulletin: {} } },
    { mode: { type: 'other' } },
    { source: { type: 'url' } }, { source: { type: 'text' } },
    { source: [{ type: 'text', text: 'Valid' }, { type: 'url' }] },
  ]) expect((await pair.callTool(tool(podcast.profile), { ...args(podcast), body: { ...podcast.args.body, ...body } })).isError).toBe(true);
  for (const extra of [{ headers: { 'safety-identifier': 'caller' } }, { header_params: { 'safety-identifier': 'caller' } }, { 'safety-identifier': 'caller' }]) {
    expect((await pair.callTool(tool(podcast.profile), { ...args(podcast), ...extra })).isError).toBe(true);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it.each(uploads.flatMap(row => uploads.map(sample => ({ row, sample: sample.multipart! }))))('$row.id preserves TXT/HTML bytes, deprecated fields and repeated locator strings', async ({ row, sample }) => {
  const filePath = path.join(workspace, sample.fileName); fs.writeFileSync(filePath, Buffer.from(sample.bytes));
  const requests: Request[] = [];
  mswServer.use(http.post(`https://api.elevenlabs.io${row.path}`, async ({ request }) => {
    requests.push(request);
    const form = await request.formData();
    expect([...form].filter(([, value]) => typeof value === 'string')).toEqual(row.multipart!.scalars);
    expect([...form.keys()]).toEqual([...row.multipart!.scalars.map(([name]) => name), 'file']);
    const file = form.get('file') as File;
    expect(file.name).toBe(sample.fileName); expect(file.type).toBe(sample.mime);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from(sample.bytes));
    return HttpResponse.json(row.response);
  }));
  const result = await pair.callTool(tool(row.profile), { ...args(row), files: [{ field: 'file', file_path: filePath }] });
  expect(result.isError, result.text).not.toBe(true); expect(requests).toHaveLength(1);
  expect(data(result.text)).toEqual(row.response);
  const discovered = await pair.callTool('elevenlabs_discover_api', { operation_id: row.id });
  expect(discovered.text).toContain('not proof of a published result');
  if (row.profile === 'create') {
    expect(row.args.body?.auto_convert).toBe(true); expect(data(result.text).converting).toBe(false);
    expect(discovered.text).toContain('deprecated');
    const op = await getOperation(row.id);
    const schema = op.request.schema as { properties: Record<string, { deprecated?: boolean }> };
    for (const field of ['image', 'small', 'sessionization']) expect(schema.properties[field].deprecated).toBe(true);
  } else {
    expect(row.args.body).toEqual({ auto_convert: false, auto_publish: true });
    expect(data(result.text)).toMatchObject({ converting: true, publishing: false });
    expect(discovered.text).toContain('auto_publish can publish a new snapshot');
  }
});

it.each(writes)('$id gives honest unavailable retry guidance and only explicit follow-ups', async row => {
  const op = await getOperation(row.id);
  expect(op.timeout).toBe('long'); expect(op.follow_ups).toEqual(row.follow_ups);
  expect(op.retry_check).toMatchObject({ unavailable_reason: expect.stringMatching(/No verifiable lookup|no verifiable lookup|No URL-to-project content\/status lookup/) });
  expect(JSON.stringify(op.retry_check)).toContain('Do not repeat');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Synthetic connection loss'));
  const result = await pair.callTool(tool(row.profile), args(row));
  expect(result.isError).toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(result.text).toContain('No verifiable lookup'); expect(result.text).toContain('No automatic retry');
  expect(result.text).toContain((op.retry_check as { unavailable_reason: string }).unavailable_reason);
});

it('discloses unconditional URL auto-publication and retains returned flags without inventing completion', async () => {
  const row = cases.find(row => row.id === 'audio_native_update_content_from_url')!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(row.response));
  const result = await pair.callTool(tool(row.profile), args(row));
  expect(result.isError, result.text).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(data(result.text)).toMatchObject({ converting: false, publishing: true });
  const discovered = await pair.callTool('elevenlabs_discover_api', { operation_id: row.id });
  expect(discovered.text).toContain('always queues conversion and auto-publication');
  expect(discovered.text).toContain('not proof of a published result');
});

it.each(['processing', 'ready', 'null'])('reads player settings in %s state without files or implied article verification', async state => {
  const row = cases.find(row => row.profile === 'read')!;
  const response = { enabled: true, snapshot_id: state === 'ready' ? 'snapshot_example' : null, settings: state === 'null' ? null : {
    ...row.response.settings, status: state, audio_path: state === 'ready' ? 'audio/article.mp3' : null, audio_url: state === 'ready' ? 'https://media.example.com/article.mp3' : null,
  } };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response));
  const result = await pair.callTool(tool(row.profile), args(row));
  expect(result.isError, result.text).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(data(result.text)).toEqual(response); expect(fs.readdirSync(workspace)).toEqual([]);
  const op = await getOperation(row.id);
  expect(op.timeout).toBe('standard'); expect(op.request.files).toBeUndefined();
  expect(op.follow_ups).toEqual([]); expect(op.retry_check).toBeUndefined();
  expect(op.effect_note).toContain('Repeat the same read');
  expect(op.effect_reason).toContain('not article content');
  expect((await pair.callTool(tool(row.profile), { ...args(row), files: [{ field: 'file', file_path: 'article.txt' }] })).isError).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  { id: 'create_podcast', patch: { source: { type: 'url', url: 'SECRET' } } },
  { id: 'create_podcast', patch: { source: [{ type: 'text', text: 'Acme' }, { type: 'url', url: 'SECRET' }, { type: 'url', url: 'SECRET' }] } },
  { id: 'create_podcast', patch: { callback_url: 'SECRET' } },
  { id: 'create_audio_native_project', patch: { image: 'SECRET' } },
  { id: 'audio_native_update_content_from_url', patch: { url: 'SECRET' } },
])('$id redacts each submitted URL branch from receipts and errors without fetching it', async ({ id, patch }) => {
  const row = cases.find(row => row.id === id)!;
  const secret = 'https://reader:synthetic-url-password@docs.example.com/article?credential=synthetic';
  const body = { ...row.args.body, ...JSON.parse(JSON.stringify(patch).replaceAll('SECRET', secret)) };
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const failed of [false, true]) {
    fetch.mockResolvedValueOnce(Response.json(failed ? { detail: { message: secret + ' ' + encodeURIComponent(secret) } } : { ...row.response, diagnostic: secret + ' ' + encodeURIComponent(secret) }, { status: failed ? 400 : 200 }));
    const result = await pair.callTool(tool(row.profile), { ...args(row), body });
    expect(Boolean(result.isError)).toBe(failed);
    for (const value of [secret, encodeURIComponent(secret), 'synthetic-url-password']) expect(result.text).not.toContain(value);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url] of fetch.mock.calls) expect(String(url)).toBe(`https://api.elevenlabs.io${row.path}`);
});

it.each(uploads)('$id requires the exact file authorization and refuses non-TXT/HTML before dispatch', async row => {
  await pair.close(); pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  const source = path.join(workspace, 'article.txt'); fs.writeFileSync(source, 'Acme article');
  const sent: string[] = [];
  mswServer.use(http.post(`https://api.elevenlabs.io${row.path}`, async ({ request }) => {
    sent.push(await ((await request.formData()).get('file') as File).text());
    return HttpResponse.json(row.response);
  }));
  const fetch = vi.spyOn(globalThis, 'fetch');
  const input = { ...args(row), files: [{ field: 'file', file_path: source }] };
  for (const reads of [[], [{ location: ['files', 1, 'file_path'], rawPath: source, canonicalPath: source }]]) {
    expect((await pair.client.callTool({ name: tool(row.profile), arguments: input, _meta: { 'files/readMode': { version: 1, mode: 'central', reads } } })).isError).toBe(true);
  }
  expect(fetch).not.toHaveBeenCalled();
  const result = await pair.client.callTool({ name: tool(row.profile), arguments: input, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['files', 0, 'file_path'], rawPath: source, canonicalPath: source }] } } });
  expect(result.isError, JSON.stringify(result)).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(sent).toEqual(['Acme article']);
  await pair.close(); pair = await createInMemoryTestClient({ createServer }); fetch.mockClear();
  for (const filePath of [path.join(workspace, 'article.pdf'), 'https://docs.example.com/article']) {
    fs.writeFileSync(path.join(workspace, 'article.pdf'), '%PDF synthetic');
    const refused = await pair.callTool(tool(row.profile), { ...args(row), files: [{ field: 'file', file_path: filePath }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(filePath.startsWith('https:') ? 'FILE_NOT_FOUND' : 'INVALID_FILE_TYPE');
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('gives general provider-URL guidance for local document refusals', () => {
  let resolution: string | undefined;
  try { readSandboxedFile('https://docs.example.com/article', undefined, ['files', 0, 'file_path'], 'document'); }
  catch (error) { resolution = (error as { resolution: string }).resolution; }
  expect(resolution).toContain("use the operation's own URL field if it has one");
  expect(resolution).toContain('for a knowledge-base document, create_url_document_route');
});
