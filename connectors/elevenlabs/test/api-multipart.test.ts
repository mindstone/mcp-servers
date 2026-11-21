import { createServer } from 'node:http';
import { once } from 'node:events';
import { http, passthrough } from 'msw';
import { mswServer } from './helpers/setup.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { apiCatalog as original } from '../src/generated/api-catalog.js';
import { validateApiCatalog, type ApiCatalog } from '../src/api-catalog.js';
import { ApiValidator } from '../src/api-validation.js';
import { createRedactor } from '../src/api-sensitive.js';
import { multipartUpload } from '../src/api-multipart.js';
import { openSandboxedUpload } from '../src/tools/file-input.js';
import type { FileReadContext } from '../src/file-read-context.js';
import { binaryFileShape } from '../src/api-multipart-shapes.mjs';
import { compileCatalog, loadCoverageRosters } from '../scripts/generate-api-catalog.mjs';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import miniInput from './fixtures/mini-openapi.json' with { type: 'json' };

vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));

let base: string; let workspace: string;
beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multipart-'))); workspace = path.join(base, 'workspace'); fs.mkdirSync(workspace); vi.stubEnv('MCP_WORKSPACE_PATH', workspace); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(base, { recursive: true, force: true }); });
const id = 'create_file_document_route';
function synthetic(min = 0, nullable = false) {
  const raw = structuredClone(original) as ApiCatalog;
  const op = raw.operations.find(op => op.operation_id === id)!;
  const binary = { type: 'string', format: 'binary' };
  op.request.files![0].schema = nullable ? { anyOf: [binary, { type: 'null' }] } : { type: 'array', items: binary, minItems: min, maxItems: 2 };
  op.request.files![0].required = true;
  return validateApiCatalog(raw);
}
function file(name: string, value = name) { const result = path.join(base, name); fs.writeFileSync(result, value); return result; }
const redactor = createRedactor([]);

it.each(['add_project', 'edit_project_content'])('%s preserves nullable document inputs and omits null file parts', async operation_id => {
  const op = original.operations.find(item => item.operation_id === operation_id)!;
  const validator = new ApiValidator(original);
  expect(binaryFileShape(op.request.files![0].schema)).toEqual({ multiple: false, nullable: true });
  expect(op.request.files![0]).toMatchObject({ field: 'from_document', kind: 'document', required: false });
  expect(op.request.files![0].allowed_media_types).toBeUndefined();
  const body = operation_id === 'add_project' ? { name: 'Acme Guide' } : {};
  for (const files of [undefined, [{ field: 'from_document', file_path: null }]]) {
    const input = validator.validateRequest(op, { operation_id, ...(operation_id === 'edit_project_content' ? { path_params: { project_id: 'project_example' } } : {}), body, ...(files ? { files } : {}) }, redactor);
    expect(input.files).toEqual(files);
    const upload = await multipartUpload(op, input, undefined, new AbortController().signal);
    try {
      const form = await new Request('https://example.invalid/upload', { method: 'POST', body: upload.body, headers: upload.headers, duplex: 'half' } as RequestInit).formData();
      expect(form.has('from_document')).toBe(false);
      expect([...form.keys()]).toEqual(Object.keys(body));
    } finally { await upload.close(); }
  }
});

it('compiles nullable and repeated binary shapes without losing cardinality or structured field encoding', async () => {
  const spec = structuredClone(miniInput);
  const fileBody = spec.components.schemas.FileBody as unknown as { properties: Record<string, unknown>; required: string[] };
  fileBody.properties.file = { type: 'array', items: { type: 'string', format: 'binary' }, minItems: 0, maxItems: 2 };
  fileBody.properties.name = { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }, { type: 'null' }] };
  fileBody.properties.tags = { type: 'array', items: { type: 'string' } };
  const bytes = Buffer.from(JSON.stringify(spec));
  const source = { url: 'https://example.invalid/spec.json', retrieved_at: '2026-11-08T00:00:00+00:00', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, paths: 4, operations: 4 };
  const operations = Object.fromEntries(Object.values(spec.paths).flatMap(item => Object.values(item)).filter(item => 'operationId' in item).map(item => {
    const operationId = item.operationId as keyof typeof policyInput.operations;
    return [operationId, { ...policyInput.operations[operationId], follow_ups: [] }];
  }));
  const policy = { ...policyInput, source, operations, family_retry_checks: { agents: { read: 'get_agents_route' }, 'knowledge-base': { read: 'get_agents_route' } } };
  const rosters = await loadCoverageRosters(path.resolve(import.meta.dirname, '..'));
  const catalog = compileCatalog(bytes, policy, source, rosters);
  const op = catalog.operations.find(op => op.operation_id === id)!;
  expect(op.request.files![0].schema).toMatchObject({ minItems: 0, maxItems: 2 });
  expect(op.request.fields).toEqual({ name: 'json', tags: 'repeated', notify: 'scalar' });
  fileBody.properties.file = { anyOf: [{ type: 'string', format: 'binary' }, { type: 'null' }] };
  const second = Buffer.from(JSON.stringify(spec));
  const pin = { ...source, bytes: second.length, sha256: createHash('sha256').update(second).digest('hex') };
  expect(binaryFileShape(compileCatalog(second, { ...policy, source: pin }, pin, rosters).operations.find(op => op.operation_id === id)!.request.files![0].schema)).toEqual({ multiple: false, nullable: true });
});

it('represents required empty arrays, rejects omission, wrong shapes, duplicate singular fields and cardinality before I/O', () => {
  const catalog = synthetic(); const op = catalog.operations.find(op => op.operation_id === id)!; const validator = new ApiValidator(catalog);
  expect(validator.validateRequest(op, { operation_id: id, files: [{ field: 'file', file_paths: [] }] }, redactor).files).toEqual([{ field: 'file', file_paths: [] }]);
  for (const files of [undefined, [{ field: 'file', file_path: '/never/read.pdf' }], [{ field: 'file', file_paths: ['a', 'b', 'c'] }], [{ field: 'file', file_paths: [] }, { field: 'file', file_paths: [] }]]) expect(() => validator.validateRequest(op, { operation_id: id, files }, redactor)).toThrow();
  const required = synthetic(1); expect(() => new ApiValidator(required).validateRequest(required.operations.find(op => op.operation_id === id)!, { operation_id: id, files: [{ field: 'file', file_paths: [] }] }, redactor)).toThrow();
  const nullable = synthetic(0, true); const nullOp = nullable.operations.find(op => op.operation_id === id)!;
  expect(new ApiValidator(nullable).validateRequest(nullOp, { operation_id: id, files: [{ field: 'file', file_path: null }] }, redactor).files).toBeDefined();
});

it('authorizes every ordered array item at its concrete location, including outside-root paths', async () => {
  const op = synthetic().operations.find(op => op.operation_id === id)!;
  const first = file('first.txt', 'first'); const second = file('second.txt', 'second');
  const input = { operation_id: id, files: [{ field: 'file', file_paths: [first, second] }] };
  const reads = [first, second].map((rawPath, index) => ({ location: ['files', 0, 'file_paths', index], rawPath, canonicalPath: rawPath }));
  const context: FileReadContext = { version: 1, mode: 'central', reads };
  const handles: import('node:fs/promises').FileHandle[] = []; const open = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => { const handle = await open(...args); handles.push(handle); return handle; });
  await expect(multipartUpload(op, input, { ...context, reads: reads.slice(0, 1) }, new AbortController().signal)).rejects.toThrowError();
  expect(handles.every(handle => handle.fd === -1)).toBe(true);
  await expect(multipartUpload(op, input, undefined, new AbortController().signal)).rejects.toThrowError();
  const upload = await multipartUpload(op, input, context, new AbortController().signal);
  try {
    const request = new Request('https://example.invalid/upload', { method: 'POST', body: upload.body, headers: upload.headers, duplex: 'half' } as RequestInit);
    const parts = (await request.formData()).getAll('file') as File[];
    expect(await Promise.all(parts.map(part => part.text()))).toEqual(['first', 'second']);
    expect(parts.map(part => part.type)).toEqual(['text/plain', 'text/plain']);
  } finally { await upload.close(); }
});

it('streams bounded chunks from a descriptor and closes on early cancellation without buffering the whole file', async () => {
  const source = path.join(workspace, 'large.mp3'); const fd = fs.openSync(source, 'w'); fs.ftruncateSync(fd, 5_000_000_000 - 1); fs.closeSync(fd);
  const read = vi.spyOn(fs, 'readFileSync'); const handles: import('node:fs/promises').FileHandle[] = []; const open = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => { const handle = await open(...args); handles.push(handle); return handle; });
  const upload = await openSandboxedUpload(source, undefined, ['files', 0, 'file_path'], 'audio', { max_bytes: 4_999_999_999 });
  const controller = new AbortController(); const iterator = upload.chunks(controller.signal);
  expect((await iterator.next()).value?.length).toBe(65536); expect(read).not.toHaveBeenCalled();
  controller.abort(); await expect(iterator.next()).rejects.toThrow(); expect(handles.every(handle => handle.fd === -1)).toBe(true);
  await expect(openSandboxedUpload(source, undefined, [], 'audio', { max_bytes: 4_999_999_998 })).rejects.toThrowError();
});

it('refuses non-regular files and descriptor replacement and detects replacement after a chunk', async () => {
  await expect(openSandboxedUpload(workspace, undefined, [], 'document', {})).rejects.toThrowError();
  const source = path.join(workspace, 'source.txt'); fs.writeFileSync(source, 'original');
  const realOpen = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => { fs.renameSync(source, source + '.old'); fs.writeFileSync(source, 'replaced'); return realOpen(...args); });
  await expect(openSandboxedUpload(source, undefined, [], 'document', {})).rejects.toThrowError(/changed/);
  vi.restoreAllMocks();
  const upload = await openSandboxedUpload(source, undefined, [], 'document', {}); const iterator = upload.chunks(new AbortController().signal);
  await iterator.next(); fs.renameSync(source, source + '.new'); fs.writeFileSync(source, 'other');
  await expect(iterator.next()).rejects.toThrowError(/changed/);
});

it.each(['unchanged', 'grows', 'shrinks'])('sends a fixed Content-Length over loopback and refuses a file that %s after opening', async mutation => {
  const source = path.join(workspace, 'wire.txt'); fs.writeFileSync(source, Buffer.alloc(200000, 65));
  const op = original.operations.find(item => item.operation_id === id)!;
  const upload = await multipartUpload(op, { operation_id: id, files: [{ field: 'file', file_path: source }] }, undefined, new AbortController().signal);
  if (mutation === 'grows') fs.appendFileSync(source, 'extra');
  if (mutation === 'shrinks') fs.truncateSync(source, 10);
  let received = 0; let headers: import('node:http').IncomingHttpHeaders = {};
  const server = createServer((request, response) => {
    headers = request.headers;
    request.on('data', chunk => { received += chunk.length; });
    request.on('error', () => response.destroy());
    request.on('end', () => { response.end('ok'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  const url = `http://127.0.0.1:${address.port}/upload`;
  mswServer.use(http.post(url, () => passthrough()));
  try {
    const response = fetch(url, { method: 'POST', body: upload.body, headers: upload.headers, duplex: 'half' } as RequestInit);
    if (mutation === 'unchanged') {
      expect(await (await response).text()).toBe('ok');
      expect(headers['content-length']).toBe(upload.headers['Content-Length']);
      expect(headers['transfer-encoding']).toBeUndefined();
      expect(received).toBe(Number(headers['content-length']));
    } else await expect(response).rejects.toThrow();
  } finally { await upload.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
