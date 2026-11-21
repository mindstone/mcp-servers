import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { http, HttpResponse } from 'msw';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import { setApiKey } from '../src/auth.js';
import { getOperation } from '../src/api-catalog.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import { mswServer } from './helpers/setup.js';
import cases from './fixtures/api-assets-wire-cases.json' with { type: 'json' };

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, promises: { ...actual.promises, open: vi.fn(actual.promises.open) } };
});
let workspace: string, pair: McpTestClient;
const upload = cases.find(row => row.id === 'upload_asset')!;
const args = (row: typeof cases[number]) => ({ operation_id: row.id, ...row.args });
const tool = (profile: string) => `elevenlabs_${profile}_resource`;
const data = (text: string) => JSON.parse(unwrapUntrusted(JSON.parse(text).data));
const fileArgs = () => ({ ...args(upload), files: [{ field: 'asset', file_path: path.join(workspace, upload.multipart!.fileName) }] });
beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assets-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace); setApiKey('synthetic-assets-key');
  fs.writeFileSync(path.join(workspace, upload.multipart!.fileName), Buffer.from(upload.multipart!.bytes));
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => {
  await pair.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setApiKey('');
  fs.rmSync(workspace, { recursive: true, force: true });
});

it.each(cases)('$id preserves literal method, path, query, bytes, response and effects', async row => {
  const requests: Request[] = [];
  mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => {
    requests.push(request);
    expect(request.method).toBe(row.method); expect(new URL(request.url).pathname).toBe(row.path);
    expect([...new URL(request.url).searchParams]).toEqual(row.query);
    expect(request.headers.get('xi-api-key')).toBe('synthetic-assets-key');
    expect(request.redirect).toBe('manual');
    if (row.multipart) {
      const form = await request.formData();
      expect([...form.keys()]).toEqual(['name', 'asset']);
      expect([...form].filter(([, value]) => typeof value === 'string')).toEqual(row.multipart.scalars);
      const file = form.get('asset') as File;
      expect(file.name).toBe('sample.custom'); expect(file.type).toBe('application/octet-stream');
      expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([0, 255, 128, 13, 10, 65, 0, 66]));
    } else expect(await request.text()).toBe('');
    return row.status === 204 ? new HttpResponse(null, { status: 204 }) : HttpResponse.json(row.response);
  }));
  const result = await pair.callTool(tool(row.profile), row.multipart ? fileArgs() : args(row));
  expect(result.isError, result.text).not.toBe(true); expect(requests).toHaveLength(1);
  const output = JSON.parse(result.text);
  expect(output).toMatchObject({ status: row.status, response_contract: 'matched', follow_up_operations: row.follow_ups, effects: {
    readOnlyHint: row.profile === 'read', destructiveHint: row.profile === 'delete', idempotentHint: row.profile === 'read', openWorldHint: true,
  } });
  if (row.status === 204) { expect(output.data).toBeNull(); expect(output.content_type).toBeNull(); }
  else expect(data(result.text)).toEqual(row.response);
  const op = await getOperation(row.id);
  expect(op.timeout).toBe(row.multipart ? 'long' : 'standard');
  if (row.multipart) {
    expect(op.request.files).toHaveLength(1);
    expect(op.request.files![0]).toMatchObject({ field: 'asset', kind: 'document', required: true });
    for (const field of ['allowed_media_types', 'max_bytes', 'max_total_bytes']) expect(op.request.files![0]).not.toHaveProperty(field);
  } else expect(op.request.files).toBeUndefined();
  expect(fs.readdirSync(workspace)).toEqual(['sample.custom']);
});

it.each([null, 'https://media.example.com/content/asset?signature=synthetic-signed-reference'])('keeps content_url %j wrapped and never fetches, saves or logs it', async content_url => {
  const row = cases.find(item => item.id === 'get_asset')!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ...row.response, content_url }));
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
  const result = await pair.callTool(tool(row.profile), args(row));
  expect(result.isError, result.text).not.toBe(true); expect(data(result.text).content_url).toBe(content_url);
  expect(JSON.parse(result.text).data).toMatch(/^<untrusted-content source="elevenlabs:api:get_asset">/);
  expect(fetch).toHaveBeenCalledOnce(); expect(String(fetch.mock.calls[0][0])).toBe('https://api.elevenlabs.io/v1/assets/asset_example');
  expect(fs.readdirSync(workspace)).toEqual(['sample.custom']);
  if (content_url) for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(content_url);
  const discovery = await pair.callTool('elevenlabs_discover_api', { operation_id: row.id });
  expect(discovery.text).toContain('null while processing'); expect(discovery.text).toContain('beyond one hour');
});

it('requires name and a file with the asset binding before any request', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const input of [
    { ...fileArgs(), body: {} }, { ...fileArgs(), body: undefined }, args(upload),
    { ...fileArgs(), files: [{ field: 'file', file_path: path.join(workspace, 'sample.custom') }] },
    { ...fileArgs(), body: { name: 'Acme', asset: 'sample.custom' } },
  ]) {
    const result = await pair.callTool(tool(upload.profile), input);
    expect(result.isError).toBe(true); expect(result.text).toContain('VALIDATION_ERROR');
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('requires exact per-file authorization and streams the authorized descriptor bytes', async () => {
  await pair.close(); pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  const source = fileArgs().files[0].file_path;
  const observed: Buffer[] = [];
  mswServer.use(http.post('https://api.elevenlabs.io/v1/assets', async ({ request }) => {
    observed.push(Buffer.from(await ((await request.formData()).get('asset') as File).arrayBuffer()));
    return HttpResponse.json(upload.response);
  }));
  const fetch = vi.spyOn(globalThis, 'fetch');
  const read = vi.mocked(fs.promises.open); read.mockClear();
  for (const reads of [[], [{ location: ['files', 1, 'file_path'], rawPath: source, canonicalPath: source }]]) {
    const result = await pair.client.callTool({ name: tool(upload.profile), arguments: fileArgs(), _meta: { 'files/readMode': { version: 1, mode: 'central', reads } } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('FILE_AUTHORIZATION_ERROR');
  }
  expect(fetch).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(observed).toEqual([]);
  const result = await pair.client.callTool({ name: tool(upload.profile), arguments: fileArgs(), _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['files', 0, 'file_path'], rawPath: source, canonicalPath: source }] } } });
  expect(result.isError, JSON.stringify(result)).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(observed).toEqual([Buffer.from([0, 255, 128, 13, 10, 65, 0, 66])]); expect(read).toHaveBeenCalledOnce();
});

it('refuses a directory, remote URL and unsafe size without dispatching', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  for (const [file_path, code] of [[workspace, 'INVALID_FILE_TYPE'], ['https://docs.example.com/asset', 'FILE_NOT_FOUND']]) {
    const result = await pair.callTool(tool(upload.profile), { ...args(upload), files: [{ field: 'asset', file_path }] });
    expect(result.isError).toBe(true); expect(result.text).toContain(code);
  }
  const stat = fs.statSync(fileArgs().files[0].file_path);
  vi.spyOn(fs, 'statSync').mockReturnValue({ ...stat, isFile: () => true, size: Number.MAX_SAFE_INTEGER + 1 } as fs.Stats);
  const result = await pair.callTool(tool(upload.profile), fileArgs());
  expect(result.isError).toBe(true); expect(result.text).toContain('FILE_TOO_LARGE'); expect(fetch).not.toHaveBeenCalled();
});

it('does not invent an upload-ID lookup after a lost response', async () => {
  const op = await getOperation(upload.id);
  expect(op.retry_check).toHaveProperty('unavailable_reason');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Synthetic connection loss'));
  const result = await pair.callTool(tool(upload.profile), fileArgs());
  expect(result.isError).toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect(result.text).toContain((op.retry_check as { unavailable_reason: string }).unavailable_reason);
  expect(result.text).toContain('No automatic retry');
});

it('continues assets explicitly, omits null filters and enforces both pinned page-size bounds', async () => {
  const row = cases.find(item => item.id === 'list_assets')!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(row.response));
  const first = await pair.callTool(tool(row.profile), args(row));
  expect(first.isError, first.text).not.toBe(true); expect(JSON.parse(first.text).next).toContain('query_params.cursor');
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValueOnce(Response.json({ assets: [], next_cursor: null, has_more: false }));
  const next = await pair.callTool(tool(row.profile), { ...args(row), query_params: { cursor: data(first.text).next_cursor, page_size: 100, search: null } });
  expect(next.isError, next.text).not.toBe(true); expect(JSON.parse(next.text).next).toBeUndefined();
  const query = new URL(String(fetch.mock.calls[1][0])).searchParams;
  expect([...query]).toEqual([['cursor', 'next asset/+?'], ['page_size', '100']]);
  for (const page_size of [0, 101]) expect((await pair.callTool(tool(row.profile), { ...args(row), query_params: { page_size } })).isError).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(cases)('$id refuses every wrong profile and files on reads/deletes before any request', async row => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const read = vi.mocked(fs.promises.open); read.mockClear();
  for (const profile of ['read_resource', 'create_resource', 'change_resource', 'delete_resource', 'run_job', 'run_agent_tests', 'query_knowledge', 'place_call'].filter(profile => `elevenlabs_${profile}` !== tool(row.profile))) {
    const result = await pair.callTool(`elevenlabs_${profile}`, args(row));
    expect(result.isError).toBe(true); expect(result.text).toContain('WRONG_TOOL');
  }
  if (!row.multipart) expect((await pair.callTool(tool(row.profile), { ...args(row), files: fileArgs().files })).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
