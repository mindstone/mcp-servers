import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createMockGeminiResponse } from './fixtures/nano-banana-data.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';

let base: string;
let pair: McpTestClient;
afterEach(async () => {
  try {
    await pair?.close();
  } finally {
    vi.unstubAllEnvs();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  }
});

it('preserves scalar and array image bytes through the SDK and does not treat output paths as reads', async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-sdk-')));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const canonical = path.join(base, 'source.png');
  const bytes = Buffer.alloc(1024, 7);
  fs.writeFileSync(canonical, bytes);
  const alias = path.join(workspace, 'alias.png');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
  vi.stubEnv('GEMINI_API_KEY', 'synthetic-api-key');
  vi.resetModules();
  const { createServer } = await import('../src/server.js');
  pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  const images: unknown[] = [];
  mswServer.use(http.post('https://generativelanguage.googleapis.com/v1beta/models/:model\\:generateContent', async ({ request }) => {
    const body = await request.json() as { contents: { parts: { inlineData?: unknown }[] }[] };
    images.push(...body.contents[0].parts.flatMap(part => part.inlineData ? [part.inlineData] : []));
    return HttpResponse.json(createMockGeminiResponse());
  }));
  const args = { source_image_path: alias, source_image_paths: [canonical], prompt: 'Acme edit', save_path: path.join(workspace, 'output.png') };
  const reads = [{ location: ['source_image_path'], rawPath: alias, canonicalPath: canonical }, { location: ['source_image_paths', 0], rawPath: canonical, canonicalPath: canonical }];
  const result = await pair.client.callTool({ name: 'nano_banana_edit', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads } } });
  expect(result.isError).toBeFalsy();
  expect(images).toEqual([{ mimeType: 'image/png', data: bytes.toString('base64') }, { mimeType: 'image/png', data: bytes.toString('base64') }]);
  expect(fs.existsSync(args.save_path)).toBe(true);
  const refused = await pair.client.callTool({ name: 'nano_banana_edit', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
  expect(refused.isError).toBe(true);
  expect(images).toHaveLength(2);
});

it.skipIf(process.platform === 'win32').each(['leaf', 'ancestor', 'alias'])('handles central %s retarget before an image edit', async kind => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-retarget-')));
  const workspace = path.join(base, 'workspace');
  const approved = path.join(base, 'approved');
  const outsideDir = path.join(base, 'outside');
  for (const dir of [workspace, approved, outsideDir]) fs.mkdirSync(dir);
  const canonical = path.join(approved, 'source.png');
  const outside = path.join(outsideDir, 'source.png');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');
  const outsideBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(canonical, bytes);
  fs.writeFileSync(outside, outsideBytes);
  const alias = path.join(workspace, 'alias.png');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
  vi.stubEnv('GEMINI_API_KEY', 'synthetic-api-key');
  vi.resetModules();
  const { createServer } = await import('../src/server.js');
  pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  const images: { mimeType: string; data: string }[] = [];
  const provider = vi.fn(async (request: Request) => {
    const body: { contents: { parts: { inlineData?: { mimeType: string; data: string } }[] }[] } = await request.json();
    images.push(...body.contents[0].parts.flatMap(part => part.inlineData ? [part.inlineData] : []));
    return HttpResponse.json(createMockGeminiResponse());
  });
  mswServer.use(http.post('https://generativelanguage.googleapis.com/v1beta/models/:model\\:generateContent', ({ request }) => provider(request)));
  const args = { source_image_path: alias, prompt: 'Acme edit' };
  const metadata = { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['source_image_path'], rawPath: alias, canonicalPath: canonical }] } };
  const ordinary = await pair.client.callTool({ name: 'nano_banana_edit', arguments: args, _meta: metadata });
  expect(ordinary.isError).toBeFalsy();
  expect(images).toEqual([{ mimeType: 'image/png', data: bytes.toString('base64') }]);
  const control = await pair.client.callTool({ name: 'nano_banana_edit', arguments: { ...args, source_image_path: outside }, _meta: { 'files/readMode': {
    version: 1, mode: 'central', reads: [{ location: ['source_image_path'], rawPath: outside, canonicalPath: outside }],
  } } });
  expect(control.isError).toBeFalsy();
  expect(images[1]).toEqual({ mimeType: 'image/png', data: outsideBytes.toString('base64') });
  provider.mockClear();
  images.length = 0;
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
  const result = await pair.client.callTool({ name: 'nano_banana_edit', arguments: args, _meta: metadata });
  if (kind === 'alias') {
    expect(result.isError).toBeFalsy();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(images).toEqual([{ mimeType: 'image/png', data: bytes.toString('base64') }]);
  } else {
    expect.soft(result.isError).toBe(true);
    expect.soft(provider).not.toHaveBeenCalled();
    expect.soft(images).toEqual([]);
    expect.soft(JSON.stringify(result)).not.toContain(outsideBytes.toString('base64'));
    expect(JSON.stringify(result)).not.toContain(outside);
  }
});
