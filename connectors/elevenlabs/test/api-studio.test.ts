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

let workspace: string, pair: McpTestClient;
const downloads = cases.filter(row => row.media !== 'application/json');
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

it.each(cases)('$id preserves its literal wire contract, effects and result through the SDK', async row => {
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
