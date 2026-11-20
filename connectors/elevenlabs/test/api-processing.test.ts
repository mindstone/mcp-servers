import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { http, HttpResponse } from 'msw';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { mswServer } from './helpers/setup.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));
let workspace: string; let pair: McpTestClient | undefined;
beforeEach(() => { workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'processing-'))); vi.stubEnv('MCP_WORKSPACE_PATH', workspace); });
afterEach(async () => { await pair?.close(); pair = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(workspace, { recursive: true, force: true }); });
async function setup(negotiated = false) {
  const { setApiKey } = await import('../src/auth.js'); setApiKey('synthetic-processing-key');
  const { createServer } = await import('../src/server.js');
  pair = await createInMemoryTestClient({ createServer, ...(negotiated ? { clientCapabilities: FILE_READ_CAPABILITIES } : {}) });
  return pair;
}
const transcript = { language_code: 'en', language_probability: 0.98, text: 'Welcome to Acme.', words: [] };

it.each([
  { status: 200, body: transcript, controls: {} },
  { status: 200, body: { transcripts: [{ ...transcript, channel_index: 0 }, { ...transcript, text: 'Second channel.', channel_index: 1 }] }, controls: { use_multi_channel: true, multichannel_output_style: 'separate' } },
  { status: 202, body: { request_id: 'request_example', message: 'Accepted for webhook delivery.' }, controls: { webhook: true, webhook_id: 'webhook_example' } },
])('preserves transcription status $status and synchronous, multichannel or queued data without polling', async ({ status, body, controls }) => {
  const client = await setup(); let requests = 0;
  const file = path.join(workspace, 'source.wav'); fs.writeFileSync(file, new Uint8Array([0, 255, 128]));
  mswServer.use(http.post('https://api.elevenlabs.io/v1/speech-to-text', async ({ request }) => {
    requests++; const form = await request.formData();
    for (const [key, value] of Object.entries(controls)) expect(form.get(key)).toBe(String(value));
    expect(await (form.get('file') as File).arrayBuffer()).toEqual(new Uint8Array([0, 255, 128]).buffer);
    return HttpResponse.json(body, { status });
  }));
  const result = await client.callTool('elevenlabs_run_job', { operation_id: 'speech_to_text', body: { model_id: 'scribe_v2', ...controls }, files: [{ field: 'file', file_path: file }] });
  expect(result.isError, result.text).not.toBe(true);
  expect(result.json).toMatchObject({ status, response_contract: 'matched', follow_up_operations: [] });
  expect(result.text).toContain(status === 202 ? 'request_example' : 'Welcome to Acme.');
  expect(requests).toBe(1);
});

it('forwards provider-fetched URLs without local reads, preserves string metadata, null and omission, and redacts URL diagnostics', async () => {
  const client = await setup(); const open = vi.spyOn(fs, 'openSync'); const forms: FormData[] = [];
  mswServer.use(http.post('https://api.elevenlabs.io/v1/speech-to-text', async ({ request }) => { forms.push(await request.formData()); return HttpResponse.json(transcript); }));
  for (const files of [undefined, [{ field: 'file', file_path: null }]]) {
    const result = await client.callTool('elevenlabs_run_job', { operation_id: 'speech_to_text', body: { model_id: 'scribe_v2', source_url: 'https://example.invalid/fake-recording.wav?token=obviously-fake', webhook_metadata: '{"reference":"example"}', seed: null }, ...(files ? { files } : {}) });
    expect(result.isError, result.text).not.toBe(true);
  }
  expect(open).not.toHaveBeenCalled();
  expect(forms[0].has('file')).toBe(false); expect(forms[1].has('file')).toBe(false);
  expect(forms[0].has('seed')).toBe(false); expect(forms[1].has('seed')).toBe(false); expect(forms[0].get('webhook_metadata')).toBe('{"reference":"example"}');
  const secretUrl = 'https://example.invalid/fake-recording.wav?token=obviously-fake';
  mswServer.use(http.post('https://api.elevenlabs.io/v1/speech-to-text', () => HttpResponse.json({ detail: secretUrl }, { status: 400 })));
  const error = await client.callTool('elevenlabs_run_job', { operation_id: 'speech_to_text', body: { model_id: 'scribe_v2', source_url: secretUrl } });
  expect(error.text).not.toContain(secretUrl); expect(error.text).not.toContain('obviously-fake');
  const localUrl = await client.callTool('elevenlabs_run_job', { operation_id: 'speech_to_text', body: { model_id: 'scribe_v2' }, files: [{ field: 'file', file_path: secretUrl }] });
  expect(localUrl.json).toMatchObject({ code: 'FILE_NOT_FOUND' }); expect(open).not.toHaveBeenCalled();
});

it('refuses undeclared, duplicate and wrong-cardinality operands before any authentication, file open or HTTP', async () => {
  const client = await setup(); const auth = await import('../src/auth.js'); const key = vi.spyOn(auth, 'getApiKey'); const open = vi.spyOn(fs, 'openSync'); const fetch = vi.spyOn(globalThis, 'fetch');
  for (const files of [[{ field: 'file', file_path: '/never/read.wav' }], [{ field: 'audio', file_paths: ['/never/read.wav'] }], [{ field: 'audio', file_path: '/never/read.wav' }, { field: 'audio', file_path: '/never/read.wav' }], [{ field: 'audio', file_path: null }]]) {
    const result = await client.callTool('elevenlabs_run_job', { operation_id: 'audio_isolation', files });
    expect(result.json).toMatchObject({ code: 'VALIDATION_ERROR' });
  }
  expect(key).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('supports negotiated outside-root files on the reviewed POST read and fails closed without that operand', async () => {
  const client = await setup(true); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'similar-'));
  try {
    const file = path.join(outside, 'sample.mp3'); fs.writeFileSync(file, 'sample'); let requests = 0;
    mswServer.use(http.post('https://api.elevenlabs.io/v1/similar-voices', async ({ request }) => { requests++; expect(await ((await request.formData()).get('audio_file') as File).text()).toBe('sample'); return HttpResponse.json({ voices: [], has_more: false }); }));
    const args = { operation_id: 'get_similar_library_voices', files: [{ field: 'audio_file', file_path: file }] };
    const result = await client.client.callTool({ name: 'elevenlabs_read_resource', arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: [{ location: ['files', 0, 'file_path'], rawPath: file, canonicalPath: fs.realpathSync(file) }] } } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const denied = await client.callTool('elevenlabs_read_resource', args);
    expect(denied.json).toMatchObject({ code: 'FILE_AUTHORIZATION_ERROR' }); expect(requests).toBe(1);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

it.each(['AbortError', 'TimeoutError'])('closes a partially consumed upload on %s without retry', async name => {
  await setup(); const source = path.join(workspace, 'source.wav'); fs.writeFileSync(source, Buffer.alloc(128 * 1024));
  const handles: import('node:fs/promises').FileHandle[] = []; const realOpen = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => { const handle = await realOpen(...args); handles.push(handle); return handle; });
  const controller = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, options) => {
    const reader = (options!.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); await reader.read();
    controller.abort(new DOMException('Synthetic interruption', name));
    throw controller.signal.reason;
  });
  const { executeApiOperation } = await import('../src/api-executor.js');
  await expect(executeApiOperation('run_job', { operation_id: 'audio_isolation', files: [{ field: 'audio', file_path: source }] })).rejects.toMatchObject({ code: name === 'AbortError' ? 'CANCELLED' : 'TIMEOUT', resolution: expect.stringContaining('No automatic retry') });
  expect(handles.every(handle => handle.fd === -1)).toBe(true); expect(fetch).toHaveBeenCalledOnce(); expect(fs.readdirSync(workspace)).toEqual(['source.wav']);
});

it.each(['AbortError', 'TimeoutError'])('cleans a partially written response and closes the uploaded descriptor on %s', async name => {
  await setup(); const source = path.join(workspace, 'source.wav'); fs.writeFileSync(source, 'sample');
  const handles: import('node:fs/promises').FileHandle[] = [];
  const controller = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const originalOpen = fs.promises.open;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args); handles.push(handle); if (args[1] !== 'wx') return handle; const write = handle.write.bind(handle);
    vi.spyOn(handle, 'write').mockImplementationOnce(async (...writeArgs: Parameters<typeof write>) => {
      const result = await write(...writeArgs); controller.abort(new DOMException('Synthetic interruption', name)); return result;
    }); return handle;
  });
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(new Uint8Array([0, 255, 128]), { headers: { 'Content-Type': 'audio/mpeg' } }));
  const { executeApiOperation } = await import('../src/api-executor.js');
  await expect(executeApiOperation('run_job', { operation_id: 'audio_isolation', files: [{ field: 'audio', file_path: source }] })).rejects.toMatchObject({ code: name === 'AbortError' ? 'CANCELLED' : 'TIMEOUT' });
  expect(handles.every(handle => handle.fd === -1)).toBe(true); expect(fetch).toHaveBeenCalledOnce(); expect(fs.readdirSync(workspace)).toEqual(['source.wav']);
});


it.each(['audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/ogg', 'application/octet-stream'])('refuses undeclared %s on an unbound isolation response', async media => {
  const client = await setup(); const source = path.join(workspace, 'source.wav'); fs.writeFileSync(source, 'sample');
  mswServer.use(http.post('https://api.elevenlabs.io/v1/audio-isolation', () => new HttpResponse(new Uint8Array([0, 255]), { headers: { 'Content-Type': media } })));
  const result = await client.callTool('elevenlabs_run_job', { operation_id: 'audio_isolation', files: [{ field: 'audio', file_path: source }] });
  expect(result.json).toMatchObject({ code: 'INVALID_RESPONSE' }); expect(fs.readdirSync(workspace)).toEqual(['source.wav']);
});
