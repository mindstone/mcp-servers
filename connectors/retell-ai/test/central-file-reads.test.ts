import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
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

it('uploads canonical file-array bytes through the SDK and refuses missing operands before upload', async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-sdk-')));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const canonical = path.join(base, 'source.txt');
  const bytes = Buffer.alloc(1024, 7);
  fs.writeFileSync(canonical, bytes);
  const alias = path.join(workspace, 'alias.txt');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
  vi.stubEnv('RETELL_API_KEY', 'synthetic-api-key');
  vi.resetModules();
  const { createServer } = await import('../src/server.js');
  pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  const uploads: { bytes: Buffer; name: string }[] = [];
  mswServer.use(http.post('https://api.retellai.com/create-knowledge-base', async ({ request }) => {
    const part = (await request.formData()).get('knowledge_base_files') as File;
    uploads.push({ bytes: Buffer.from(await part.arrayBuffer()), name: part.name });
    return HttpResponse.json({ knowledge_base_id: 'kb_synthetic', knowledge_base_name: 'Acme knowledge', status: 'in_progress' });
  }));
  const args = { knowledge_base_name: 'Acme knowledge', file_paths: [alias], knowledge_base_texts: [{ title: 'Acme text', text: 'Keep inline text' }], knowledge_base_urls: ['https://example.com/guide'] };
  const reads = [{ location: ['file_paths', 0], rawPath: alias, canonicalPath: canonical }];
  const result = await pair.client.callTool({ name: 'create_knowledge_base', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads } } });
  expect(result.isError).toBeFalsy();
  expect(uploads).toEqual([{ bytes, name: 'source.txt' }]);
  const refused = await pair.client.callTool({ name: 'create_knowledge_base', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
  expect(refused.isError).toBe(true);
  expect(uploads).toHaveLength(1);
});

it.skipIf(process.platform === 'win32').each(['leaf', 'ancestor', 'deleted', 'alias'])('handles central %s retarget before a knowledge-base upload', async kind => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-retarget-')));
  const workspace = path.join(base, 'workspace');
  const approved = path.join(base, 'approved');
  const outsideDir = path.join(base, 'outside');
  for (const dir of [workspace, approved, outsideDir]) fs.mkdirSync(dir);
  const canonical = path.join(approved, 'source.txt');
  const outside = path.join(outsideDir, 'source.txt');
  const bytes = Buffer.from('Acme approved knowledge');
  const outsideBytes = Buffer.from('Acme outside knowledge');
  fs.writeFileSync(canonical, bytes);
  fs.writeFileSync(outside, outsideBytes);
  const alias = path.join(workspace, 'alias.txt');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
  vi.stubEnv('RETELL_API_KEY', 'synthetic-api-key');
  vi.resetModules();
  const { createServer } = await import('../src/server.js');
  pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  const uploads: { bytes: Buffer; name: string }[] = [];
  const provider = vi.fn(async (request: Request) => {
    const part = (await request.formData()).get('knowledge_base_files');
    if (!(part instanceof File)) throw new Error('Expected the upload file');
    uploads.push({ bytes: Buffer.from(await part.arrayBuffer()), name: part.name });
    return HttpResponse.json({ knowledge_base_id: 'kb_synthetic', knowledge_base_name: 'Acme knowledge', status: 'in_progress' });
  });
  mswServer.use(http.post('https://api.retellai.com/create-knowledge-base', ({ request }) => provider(request)));
  const args = { knowledge_base_name: 'Acme knowledge', file_paths: [alias] };
  const metadata = { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['file_paths', 0], rawPath: alias, canonicalPath: canonical }] } };
  const ordinary = await pair.client.callTool({ name: 'create_knowledge_base', arguments: args, _meta: metadata });
  expect(ordinary.isError).toBeFalsy();
  expect(uploads).toEqual([{ bytes, name: 'source.txt' }]);
  const control = await pair.client.callTool({ name: 'create_knowledge_base', arguments: { ...args, file_paths: [outside] }, _meta: { 'files/readMode': {
    version: 1, mode: 'central', reads: [{ location: ['file_paths', 0], rawPath: outside, canonicalPath: outside }],
  } } });
  expect(control.isError).toBeFalsy();
  expect(uploads[1]).toEqual({ bytes: outsideBytes, name: 'source.txt' });
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
    if (kind === 'leaf') fs.symlinkSync(outside, canonical);
  }
  const result = await pair.client.callTool({ name: 'create_knowledge_base', arguments: args, _meta: metadata });
  if (kind === 'alias') {
    expect(result.isError).toBeFalsy();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(uploads).toEqual([{ bytes, name: 'source.txt' }]);
  } else {
    expect.soft(result.isError).toBe(true);
    expect.soft(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('FILE_CHANGED_DURING_READ') })]));
    expect.soft(provider).not.toHaveBeenCalled();
    expect.soft(uploads).toEqual([]);
    expect.soft(JSON.stringify(result)).not.toContain(outsideBytes.toString('base64'));
    expect(JSON.stringify(result)).not.toContain(outside);
  }
});
