import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mockUploadLinkResponse, mockResumableLocation, makeProjectResponse } from './fixtures/opus-data.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';

// On this package's msw: the shared helper's server resolves the harness's msw version, whose handler type differs.
const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

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

it('streams canonical bytes from the same fd when a hosted upload resumes', async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-sdk-')));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const canonical = path.join(base, 'source.mp4');
  const bytes = Buffer.alloc(1024, 7);
  fs.writeFileSync(canonical, bytes);
  const alias = path.join(workspace, 'alias.mp4');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
  vi.stubEnv('OPUS_API_KEY', 'synthetic-api-key');
  vi.resetModules();
  const { createServer } = await import('../src/server.js');
  pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  const chunks: Buffer[] = [];
  let queries = 0;
  mswServer.use(
    http.post('https://api.opus.pro/api/upload-links', () => HttpResponse.json(mockUploadLinkResponse)),
    http.post(mockUploadLinkResponse.url, () => new HttpResponse(null, { status: 201, headers: { location: mockResumableLocation } })),
    http.put(mockResumableLocation, async ({ request }) => {
      if (request.headers.get('Content-Range')?.startsWith('bytes */')) {
        queries++;
        return new HttpResponse(null, { status: 308, headers: { Range: 'bytes=0-511' } });
      }
      chunks.push(Buffer.from(await request.arrayBuffer()));
      return new HttpResponse(null, { status: chunks.length === 1 ? 503 : 200 });
    }),
    http.post('https://api.opus.pro/api/clip-projects', () => HttpResponse.json(makeProjectResponse())),
  );
  const args = { file_path: alias };
  const result = await pair.client.callTool({ name: 'opus_upload_video', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['file_path'], rawPath: alias, canonicalPath: canonical }] } } });
  expect(result.isError).toBeFalsy();
  expect(queries).toBe(1);
  expect(chunks).toEqual([bytes, bytes.subarray(512)]);
  const refused = await pair.client.callTool({ name: 'opus_upload_video', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [] } } });
  expect(refused.isError).toBe(true);
  expect(chunks).toHaveLength(2);
});

async function physicalReadFixture() {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-opus-physical-')));
  const workspace = path.join(base, 'workspace');
  const approved = path.join(base, 'approved');
  const outsideDir = path.join(base, 'outside');
  for (const directory of [workspace, approved, outsideDir]) fs.mkdirSync(directory);
  const canonical = path.join(approved, 'source.mp4');
  const outside = path.join(outsideDir, 'source.mp4');
  const bytes = Buffer.alloc(1024, 7);
  const outsideBytes = Buffer.alloc(1024, 9);
  fs.writeFileSync(canonical, bytes);
  fs.writeFileSync(outside, outsideBytes);
  const alias = path.join(workspace, 'alias.mp4');
  fs.symlinkSync(canonical, alias);
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
  vi.stubEnv('OPUS_API_KEY', 'synthetic-api-key');
  vi.resetModules();
  const { createServer } = await import('../src/server.js');
  pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  const requests: string[] = [];
  const chunks: Buffer[] = [];
  mswServer.use(
    http.post('https://api.opus.pro/api/upload-links', () => {
      requests.push('upload-links');
      return HttpResponse.json(mockUploadLinkResponse);
    }),
    http.post(mockUploadLinkResponse.url, () => {
      requests.push('upload-start');
      return new HttpResponse(null, { status: 201, headers: { location: mockResumableLocation } });
    }),
    http.put(mockResumableLocation, async ({ request }) => {
      requests.push('upload-put');
      chunks.push(Buffer.from(await request.arrayBuffer()));
      return new HttpResponse(null, { status: 200 });
    }),
    http.post('https://api.opus.pro/api/clip-projects', () => {
      requests.push('clip-projects');
      return HttpResponse.json(makeProjectResponse());
    }),
  );
  const request = (rawPath = alias, canonicalPath = canonical) => ({
    name: 'opus_upload_video', arguments: { file_path: rawPath },
    _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['file_path'], rawPath, canonicalPath }] } },
  });
  return { approved, canonical, outsideDir, outside, bytes, outsideBytes, alias, requests, chunks, request };
}

it.skipIf(process.platform === 'win32')('refuses central ancestor retarget before any upload or project request', async () => {
  const { approved, outsideDir, outside, bytes, outsideBytes, requests, chunks, request } = await physicalReadFixture();
  const approvedRequest = request();
  const approvedControl = await pair.client.callTool(approvedRequest);
  expect(approvedControl.isError).toBeFalsy();
  expect(chunks).toEqual([bytes]);
  expect(requests).toEqual(['upload-links', 'upload-start', 'upload-put', 'clip-projects']);
  chunks.length = 0;
  requests.length = 0;
  const outsideControl = await pair.client.callTool(request(outside, outside));
  expect(outsideControl.isError).toBeFalsy();
  expect(chunks).toEqual([outsideBytes]);
  expect(requests).toEqual(['upload-links', 'upload-start', 'upload-put', 'clip-projects']);
  chunks.length = 0;
  requests.length = 0;

  fs.renameSync(approved, path.join(base, 'approved-backup'));
  fs.symlinkSync(outsideDir, approved);
  const result = await pair.client.callTool(approvedRequest);
  const providerViolation = chunks.some(chunk => chunk.equals(outsideBytes));
  expect.soft(result.isError).toBe(true);
  expect.soft(JSON.stringify(result.content)).toMatch(/VALIDATION_ERROR/);
  expect.soft(providerViolation).toBe(false);
  expect.soft(chunks).toEqual([]);
  expect.soft(requests).toEqual([]);
  expect.soft(JSON.stringify(result)).not.toContain(outsideBytes.toString('base64'));
  expect(JSON.stringify(result)).not.toContain(outside);
});

it.skipIf(process.platform === 'win32')('uploads approved A after the raw alias is retargeted', async () => {
  const { outside, bytes, alias, requests, chunks, request } = await physicalReadFixture();
  const approvedRequest = request();
  fs.unlinkSync(alias);
  fs.symlinkSync(outside, alias);
  const result = await pair.client.callTool(approvedRequest);
  expect(result.isError).toBeFalsy();
  expect(chunks).toEqual([bytes]);
  expect(requests).toEqual(['upload-links', 'upload-start', 'upload-put', 'clip-projects']);
});

it.skipIf(process.platform !== 'linux')('keeps the existing no-follow refusal for a central leaf retarget', async () => {
  const { canonical, outside, bytes, outsideBytes, requests, chunks, request } = await physicalReadFixture();
  const approvedRequest = request();
  const approvedControl = await pair.client.callTool(approvedRequest);
  expect(approvedControl.isError).toBeFalsy();
  expect(chunks).toEqual([bytes]);
  chunks.length = 0;
  requests.length = 0;
  const outsideControl = await pair.client.callTool(request(outside, outside));
  expect(outsideControl.isError).toBeFalsy();
  expect(chunks).toEqual([outsideBytes]);
  chunks.length = 0;
  requests.length = 0;
  fs.unlinkSync(canonical);
  fs.symlinkSync(outside, canonical);
  const result = await pair.client.callTool(approvedRequest);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(/VALIDATION_ERROR/);
  expect(chunks).toEqual([]);
  expect(requests).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(outside);
});
