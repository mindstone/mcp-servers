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
  await pair?.close();
  vi.unstubAllEnvs();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

it('threads SDK metadata to transcription bytes, isolates concurrent calls, and ignores forged arguments', async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-audio-')));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const first = path.join(base, 'first.mp3');
  const second = path.join(base, 'second.mp3');
  fs.writeFileSync(first, 'Acme first recording');
  fs.writeFileSync(second, 'Acme second recording');
  const alias = path.join(workspace, 'linked.mp3');
  fs.symlinkSync(first, alias);
  vi.stubEnv('ELEVENLABS_API_KEY', 'synthetic-api-key');
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
  vi.resetModules();
  const uploads: { bytes: string; name: string; mime: string }[] = [];
  mswServer.use(http.post('https://api.elevenlabs.io/v1/speech-to-text', async ({ request }) => {
    const part = (await request.formData()).get('file') as File;
    uploads.push({ bytes: await part.text(), name: part.name, mime: part.type });
    return HttpResponse.json({ text: 'Acme transcript', words: [] });
  }));
  const { createServer } = await import('../src/server.js');
  pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  const mode = (rawPath: string, canonicalPath: string) => ({ version: 1, mode: 'central', reads: [{ location: ['file_path'], rawPath, canonicalPath }] });
  const call = (rawPath: string, metadata?: unknown, forged = false) => pair.client.callTool({
    name: 'transcribe_audio', arguments: { file_path: rawPath, ...(forged ? { _meta: { 'files/readMode': mode(rawPath, first) } } : {}) },
    ...(metadata === undefined ? {} : { _meta: { 'files/readMode': metadata } }),
  });
  const results = await Promise.all([call(alias, mode(alias, first)), call(second, mode(second, second))]);
  expect(results.every(result => !result.isError)).toBe(true);
  expect(uploads).toEqual(expect.arrayContaining([
    { bytes: 'Acme first recording', name: 'first.mp3', mime: 'audio/mpeg' },
    { bytes: 'Acme second recording', name: 'second.mp3', mime: 'audio/mpeg' },
  ]));
  const inside = path.join(workspace, 'blocked.mp3');
  fs.writeFileSync(inside, 'Acme blocked recording');
  for (const result of [await call(inside, { version: 1, mode: 'central', reads: [] }),
    await call(alias, undefined, true), await call(alias, { version: 1, mode: 'denied', reason: 'blocked' }),
    await call(alias, { version: 1, mode: 'approval_pending' }), await call(alias, { version: 1, mode: 'central', reads: 'invalid' })]) {
    expect(result.isError).toBe(true);
  }
  expect(uploads).toHaveLength(2);
  const missing = path.join(base, 'missing.mp3');
  const missingResult = await call(missing, mode(missing, missing));
  expect(JSON.stringify(missingResult.content)).toContain('FILE_NOT_FOUND');
  expect(uploads).toHaveLength(2);
});
