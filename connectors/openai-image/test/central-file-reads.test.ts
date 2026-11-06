import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
import { createInMemoryClientPair, importConnectorModule, makeImageBase64 } from './helpers.js';

let base: string;
let pair: Awaited<ReturnType<typeof createInMemoryClientPair>>;
afterEach(async () => {
  try {
    await pair?.close();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  }
});

it('edits canonical reference and mask bytes outside static roots while retaining output containment', async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-image-')));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const canonical = path.join(base, 'source.png');
  const bytes = Buffer.from(makeImageBase64(), 'base64');
  fs.writeFileSync(canonical, bytes);
  const alias = path.join(workspace, 'reference.png');
  fs.symlinkSync(canonical, alias);
  const connector = await importConnectorModule({ MCP_WORKSPACE_PATH: workspace, MCP_ALLOWED_SYMLINK_ROOTS: '[]', OPENAI_API_KEY: 'synthetic-api-key' });
  const uploads: { bytes: Buffer; name: string; mime: string }[] = [];
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = init?.body as FormData;
    for (const key of ['image[]', 'mask']) {
      const part = body.get(key) as File;
      if (part) uploads.push({ bytes: Buffer.from(await part.arrayBuffer()), name: part.name, mime: part.type });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: makeImageBase64() }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  pair = await createInMemoryClientPair(connector.createServer(), FILE_READ_CAPABILITIES);
  const args = { prompt: 'Acme edit', image_paths: [alias], mask_path: canonical };
  const reads = [{ location: ['image_paths', 0], rawPath: alias, canonicalPath: canonical }, { location: ['mask_path'], rawPath: canonical, canonicalPath: canonical }];
  const result = await pair.client.callTool({ name: 'edit_image', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads } } });
  expect(result.isError).toBeFalsy();
  expect(uploads).toEqual([{ bytes, name: 'reference.png', mime: 'image/png' }, { bytes, name: 'source.png', mime: 'image/png' }]);
  const blocked = await pair.client.callTool({ name: 'edit_image', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
  expect(blocked.isError).toBe(true);
  expect(provider).toHaveBeenCalledTimes(1);
  const standalone = await pair.client.callTool({ name: 'edit_image', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'standalone' } } });
  expect(standalone.isError).toBe(true);
  expect(provider).toHaveBeenCalledTimes(1);
});

it.skipIf(process.platform === 'win32').each(['leaf', 'ancestor', 'alias'])('keeps central %s retarget controls bound to the approved image', async kind => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-image-retarget-')));
  const workspace = path.join(base, 'workspace');
  const approved = path.join(base, 'approved');
  const outsideDir = path.join(base, 'outside');
  for (const dir of [workspace, approved, outsideDir]) fs.mkdirSync(dir);
  const canonical = path.join(approved, 'source.png');
  const outside = path.join(outsideDir, 'source.png');
  const bytes = Buffer.from(makeImageBase64(), 'base64');
  const outsideBytes = Buffer.from(bytes);
  outsideBytes.fill(2, 8);
  fs.writeFileSync(canonical, bytes);
  fs.writeFileSync(outside, outsideBytes);
  const alias = path.join(workspace, 'reference.png');
  fs.symlinkSync(canonical, alias);
  const connector = await importConnectorModule({ MCP_WORKSPACE_PATH: workspace, MCP_ALLOWED_SYMLINK_ROOTS: '[]', OPENAI_API_KEY: 'synthetic-api-key' });
  const uploads: Buffer[] = [];
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (!(init?.body instanceof FormData)) throw new Error('Expected multipart image upload');
    const part = init.body.get('image[]');
    if (!(part instanceof File)) throw new Error('Expected image file');
    uploads.push(Buffer.from(await part.arrayBuffer()));
    return new Response(JSON.stringify({ data: [{ b64_json: makeImageBase64() }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  pair = await createInMemoryClientPair(connector.createServer(), FILE_READ_CAPABILITIES);
  const args = { prompt: 'Acme edit', image_paths: [alias] };
  const metadata = { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['image_paths', 0], rawPath: alias, canonicalPath: canonical }] } };
  const ordinary = await pair.client.callTool({ name: 'edit_image', arguments: args, _meta: metadata });
  expect(ordinary.isError).toBeFalsy();
  expect(uploads).toEqual([bytes]);
  const control = await pair.client.callTool({ name: 'edit_image', arguments: { ...args, image_paths: [outside] }, _meta: { 'files/readMode': {
    version: 1, mode: 'central', reads: [{ location: ['image_paths', 0], rawPath: outside, canonicalPath: outside }],
  } } });
  expect(control.isError).toBeFalsy();
  expect(uploads[1]).toEqual(outsideBytes);
  provider.mockClear();
  uploads.length = 0;
  if (kind === 'ancestor') {
    fs.renameSync(approved, path.join(base, 'approved-backup'));
    fs.symlinkSync(outsideDir, approved);
  } else if (kind === 'alias') {
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias);
  } else {
    fs.unlinkSync(canonical);
    fs.symlinkSync(outside, canonical);
  }
  const result = await pair.client.callTool({ name: 'edit_image', arguments: args, _meta: metadata });
  if (kind === 'alias') {
    expect(result.isError).toBeFalsy();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(uploads).toEqual([bytes]);
  } else {
    expect.soft(result.isError).toBe(true);
    expect.soft(provider).not.toHaveBeenCalled();
    expect.soft(uploads).toEqual([]);
    expect.soft(JSON.stringify(result)).not.toContain(outsideBytes.toString('base64'));
    expect(JSON.stringify(result)).not.toContain(outside);
  }
});
