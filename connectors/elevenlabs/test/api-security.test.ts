import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import sharedFileWire from '../../../test-harness/test/fixtures/file-read/wire-v1.json' with { type: 'json' };
import { createServer } from '../src/server.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
import * as auth from '../src/auth.js';
import * as fileInput from '../src/tools/file-input.js';
import { multipartCases } from './fixtures/api-wire-cases.js';
import { mswServer } from './helpers/setup.js';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), openSync: vi.fn(actual.openSync) };
});

let pair: McpTestClient;
let base: string;
let workspace: string;
let approved: string;
let alias: string;
let requests: number;
const countRequest = () => { requests++; };
beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-doc-security-')));
  workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  approved = path.join(base, 'approved.txt');
  fs.writeFileSync(approved, 'Acme authorized document');
  alias = path.join(workspace, 'alias.txt');
  fs.symlinkSync(approved, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  auth.setApiKey('synthetic-document-key');
  pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  requests = 0;
  mswServer.events.on('request:start', countRequest);
});
afterEach(async () => {
  await pair?.close();
  mswServer.events.removeListener('request:start', countRequest);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  auth.setApiKey('');
  fs.rmSync(base, { recursive: true, force: true });
});

function mode(rawPath = alias, canonicalPath = approved) {
  // Reuse the shared nested-selector wire fixture, adapting only the connector's operand names.
  return { ...sharedFileWire.central, reads: sharedFileWire.central.reads.map(read => ({
    ...read, location: ['files', read.location[1], 'file_path'], rawPath, canonicalPath,
  })) };
}
function args(filePath = alias) {
  return { operation_id: 'create_file_document_route', files: [{ field: 'file', file_path: filePath }] };
}
async function call(input: Record<string, unknown>, metadata: unknown = mode(), name = 'elevenlabs_create_resource') {
  return pair.client.callTool({ name, arguments: input, ...(metadata === undefined ? {} : { _meta: { 'files/readMode': metadata } }) });
}
function json(result: Awaited<ReturnType<typeof call>>) {
  const part = result.content.find(part => part.type === 'text');
  if (!part || part.type !== 'text') throw new Error('Missing SDK text result');
  return JSON.parse(part.text) as Record<string, unknown>;
}
function uploadHandler() {
  const uploads: { name: string; mime: string; bytes: string; keys: string[] }[] = [];
  mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/knowledge-base/file', async ({ request }) => {
    const form = await request.formData();
    const file = form.get('file') as File;
    uploads.push({ name: file.name, mime: file.type, bytes: await file.text(), keys: [...form.keys()] });
    return HttpResponse.json({ id: 'doc_example', name: 'Guide' });
  }));
  return uploads;
}

describe('exact nested document read authorization through supported SDK context', () => {
  it('advertises the same nested-selector shape and reads only approved canonical bytes after raw alias retarget', async () => {
    const definitions = (await pair.client.listTools()).tools;
    for (const name of ['elevenlabs_create_resource', 'elevenlabs_change_resource']) {
      expect(definitions.find(tool => tool.name === name)!._meta?.['files/readInputs']).toMatchObject({
        version: sharedFileWire.declaration.version,
        inputs: [{ selector: ['files', '*', 'file_path'], base: sharedFileWire.declaration.inputs[0].base, expandTilde: true }],
      });
    }
    const outside = path.join(base, 'other.txt');
    fs.writeFileSync(outside, 'Acme unapproved bytes');
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias);
    const uploads = uploadHandler();
    const result = await call(args());
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(uploads).toEqual([{ name: 'approved.txt', mime: 'text/plain', bytes: 'Acme authorized document', keys: ['file'] }]);
    expect(requests).toBe(1);
  });

  it('keeps concurrent request contexts isolated', async () => {
    const second = path.join(base, 'second.md');
    fs.writeFileSync(second, 'Acme second document');
    const uploads = uploadHandler();
    const results = await Promise.all([call(args()), call(args(second), mode(second, second))]);
    expect(results.every(result => !result.isError)).toBe(true);
    expect(uploads).toEqual(expect.arrayContaining([
      { name: 'approved.txt', mime: 'text/plain', bytes: 'Acme authorized document', keys: ['file'] },
      { name: 'second.md', mime: 'text/markdown', bytes: 'Acme second document', keys: ['file'] },
    ]));
    expect(requests).toBe(2);
  });

  it.each(multipartCases)('$id requires fresh exact-operand authorization after a successful upload on the same connection', async wire => {
    const name = wire.profile === 'create' ? 'elevenlabs_create_resource' : 'elevenlabs_change_resource';
    const input = { operation_id: wire.id, ...wire.args, files: [{ field: 'file', file_path: alias }] };
    const uploads: unknown[] = [];
    mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => {
      const url = new URL(request.url);
      expect({ method: request.method, path: url.pathname, query: [...url.searchParams] })
        .toEqual({ method: wire.method, path: wire.path, query: wire.query });
      const form = await request.formData();
      const part = form.get('file') as File;
      uploads.push({ name: part.name, mime: part.type, bytes: await part.text() });
      return HttpResponse.json(wire.response);
    }));
    const allowed = await call(input, mode(), name);
    expect(allowed.isError, JSON.stringify(allowed)).not.toBe(true);
    expect(json(allowed)).toMatchObject({ ok: true, response_contract: 'matched' });
    expect(uploads).toEqual([{ name: 'approved.txt', mime: 'text/plain', bytes: 'Acme authorized document' }]);
    expect(requests).toBe(1);

    const getKey = vi.spyOn(auth, 'getApiKey');
    for (const metadata of [undefined, { ...mode(), reads: [] }, {
      ...mode(), reads: mode().reads.map(read => ({ ...read, location: ['files', 1, 'file_path'] })),
    }]) {
      const read = vi.mocked(fs.readFileSync).mockClear();
      const open = vi.mocked(fs.openSync).mockClear();
      const denied = await pair.client.callTool({ name, arguments: input,
        ...(metadata === undefined ? {} : { _meta: { 'files/readMode': metadata } }),
      });
      expect(denied.isError).toBe(true);
      expect(json(denied)).toMatchObject({ ok: false, code: 'FILE_AUTHORIZATION_ERROR' });
      expect(getKey).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(uploads).toHaveLength(1);
      expect(requests).toBe(1);
    }
  });

  it.each([
    null, {}, { version: 1, mode: 'denied' }, sharedFileWire.pending,
    { version: 1, mode: 'central', reads: [] },
    { version: 1, mode: 'central', reads: 'invalid' },
    { version: 1, mode: 'central', reads: [{ location: ['files', 1, 'file_path'], rawPath: 'RAW', canonicalPath: 'CANONICAL' }] },
    { version: 1, mode: 'central', reads: [{ location: ['body', 'file_path'], rawPath: 'RAW', canonicalPath: 'CANONICAL' }] },
    { version: 1, mode: 'central', reads: [{ location: ['files', 0, 'file_path'], rawPath: 'wrong', canonicalPath: 'CANONICAL' }] },
  ])('denies missing/malformed/incorrect concrete operand metadata before auth or HTTP: %j', async metadata => {
    const actual = JSON.parse(JSON.stringify(metadata).replaceAll('RAW', alias).replaceAll('CANONICAL', approved));
    const getKey = vi.spyOn(auth, 'getApiKey');
    const read = vi.mocked(fs.readFileSync).mockClear();
    const open = vi.mocked(fs.openSync).mockClear();
    const result = await call(args(), actual);
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ ok: false, code: 'FILE_AUTHORIZATION_ERROR' });
    expect(getKey).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(requests).toBe(0);
  });

  it('refuses absent metadata and forged argument metadata without opening files', async () => {
    const read = vi.spyOn(fileInput, 'readSandboxedFile');
    const result = await pair.client.callTool({ name: 'elevenlabs_create_resource', arguments: args() });
    expect(json(result)).toMatchObject({ code: 'FILE_AUTHORIZATION_ERROR' });
    const forged = await call({ ...args(), _meta: { 'files/readMode': mode() } }, undefined);
    expect(forged.isError).toBe(true); // Native SDK strict-envelope rejection is intentionally not connector JSON.
    expect(read).not.toHaveBeenCalled();
    expect(requests).toBe(0);
  });

  it.each([
    { operation_id: 'create_file_document_route', body: { file: '/never/read.pdf' } },
    { operation_id: 'create_file_document_route', files: [{ field: 'audio', file_path: '/never/read.pdf' }] },
    { operation_id: 'create_file_document_route', files: [{ field: 'file', file_path: '/never/read.pdf' }, { field: 'file', file_path: '/never/read2.pdf' }] },
    { operation_id: 'create_agent_route', body: { conversation_config: {} }, files: [{ field: 'file', file_path: '/never/read.pdf' }] },
  ])('validates file admission/bindings before context, file reads or auth: %j', async input => {
    const read = vi.spyOn(fileInput, 'readSandboxedFile');
    const getKey = vi.spyOn(auth, 'getApiKey');
    const result = await call(input, {});
    expect(json(result)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(read).not.toHaveBeenCalled();
    expect(getKey).not.toHaveBeenCalled();
    expect(requests).toBe(0);
  });

  it('never interprets body-hidden paths inside a legitimate provider graph as file operands', async () => {
    const read = vi.spyOn(fileInput, 'readSandboxedFile');
    let body: unknown;
    mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/agents/create', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ agent_id: 'agent_example' });
    }));
    const input = { operation_id: 'create_agent_route', body: { conversation_config: { agent: { dynamic_variables: { dynamic_variable_placeholders: { file_path: approved } } } } } };
    const result = await call(input, {});
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(body).toEqual(input.body);
    expect(read).not.toHaveBeenCalled();
    expect(requests).toBe(1);
  });

  it.each(['missing', 'directory', 'retarget'])('reports the accurate local %s file error before auth/HTTP', async kind => {
    let canonical = approved;
    if (kind === 'missing') canonical = path.join(base, 'missing.txt');
    if (kind === 'directory') canonical = base;
    if (kind === 'retarget') {
      const other = path.join(base, 'other.txt');
      fs.writeFileSync(other, 'Acme other');
      fs.unlinkSync(approved);
      fs.symlinkSync(other, approved);
    }
    const getKey = vi.spyOn(auth, 'getApiKey');
    const result = await call(args(), mode(alias, canonical));
    expect(json(result)).toMatchObject({ code: kind === 'directory' ? 'INVALID_FILE_TYPE' : 'FILE_NOT_FOUND' });
    expect(getKey).not.toHaveBeenCalled();
    expect(requests).toBe(0);
  });

  it.each(['escape', 'symlink', 'url'])('retains standalone %s refusal without remote URL fallback', async kind => {
    await pair.close();
    // close() clears env stubs; keep this client inside the intended workspace.
    pair = await createInMemoryTestClient({ createServer, env: { MCP_WORKSPACE_PATH: workspace } });
    const raw = kind === 'escape' ? path.join(workspace, '..', 'approved.txt') : kind === 'symlink' ? alias : 'https://docs.example.com/guide.pdf';
    const getKey = vi.spyOn(auth, 'getApiKey');
    const read = vi.mocked(fs.readFileSync).mockClear();
    const open = vi.mocked(fs.openSync).mockClear();
    const result = await pair.client.callTool({ name: 'elevenlabs_create_resource', arguments: args(raw) });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ code: kind === 'url' ? 'FILE_NOT_FOUND' : 'PATH_SANDBOX_VIOLATION' });
    expect(getKey).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(requests).toBe(0);
  });

  it('omits null multipart scalars and accepts a standalone canonical workspace symlink root', async () => {
    const rootAlias = path.join(base, 'workspace-alias');
    fs.symlinkSync(workspace, rootAlias);
    vi.stubEnv('MCP_WORKSPACE_PATH', rootAlias);
    const doc = path.join(rootAlias, 'guide.unknown');
    fs.writeFileSync(doc, 'Acme local document');
    const uploads = uploadHandler();
    const result = await call({ ...args(doc), body: { name: null, parent_folder_id: null } }, sharedFileWire.standalone);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(uploads).toEqual([{ name: 'guide.unknown', mime: 'application/octet-stream', bytes: 'Acme local document', keys: ['file'] }]);
    expect(requests).toBe(1);
  });
});
