import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ApiCatalog } from '../src/api-catalog.js';
import { mswServer } from './helpers/setup.js';

let workspace: string;
let pair: McpTestClient | undefined;
beforeEach(() => { workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'speech-job-'))); vi.stubEnv('MCP_WORKSPACE_PATH', workspace); });
afterEach(async () => {
  await pair?.close(); pair = undefined;
  vi.restoreAllMocks();
  vi.doUnmock('../src/generated/api-catalog.js'); vi.resetModules(); vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});
async function setup() {
  const { setApiKey } = await import('../src/auth.js'); setApiKey('synthetic-speech-key');
  const { createServer } = await import('../src/server.js');
  pair = await createInMemoryTestClient({ createServer });
  return pair;
}
const formats = [
  ...['8000', '16000', '22050', '24000', '32000', '44100', '48000'].flatMap(rate => [`wav_${rate}`, `pcm_${rate}`]),
  'ulaw_8000', 'alaw_8000', 'mp3_22050_32', 'mp3_24000_48',
  ...['32', '64', '96', '128', '192'].flatMap(rate => [`mp3_44100_${rate}`, `opus_48000_${rate}`]),
];
const bytes = new Uint8Array([0, 255, 17, 99, 128]);
describe('generic generation receipts', () => {
  it('carries the declared character-cost header into enveloped receipt metadata', async () => {
    const client = await setup();
    const { unwrapUntrusted } = await import('../src/untrusted-content.js');
    mswServer.use(http.post('https://api.elevenlabs.io/v1/sound-generation', () => new HttpResponse(bytes, { headers: {
      'Content-Type': 'audio/mpeg', 'character-cost': '42', 'x-undeclared': 'not-declared' } })));
    const result = await client.callTool('elevenlabs_run_job', { operation_id: 'sound_generation', body: { text: 'A bell.' } });
    expect(result.isError, result.text).not.toBe(true); const receipt = JSON.parse(result.text);
    expect(receipt.metadata).toMatch(/^<untrusted-content source="elevenlabs:api:sound_generation">/);
    expect(JSON.parse(unwrapUntrusted(receipt.metadata))).toEqual({ response_headers: { 'character-cost': '42' } });
  });
  it.each(['Error', 'AbortError', 'TimeoutError'])('keeps a partial paid generation after a body %s, without retrying', async name => {
    const client = await setup();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (chunks++ === 0) controller.enqueue(bytes);
      else { const error = new Error('Synthetic body failure'); error.name = name; controller.error(error); }
    } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } }));
    fs.writeFileSync(path.join(workspace, 'preserved'), 'keep');
    const result = await client.callTool('elevenlabs_run_job', { operation_id: 'sound_generation', body: { text: 'A bell.' } });
    expect(result.json).toMatchObject({ code: name === 'Error' ? 'INVALID_RESPONSE' : 'TIMEOUT', resolution: expect.stringContaining('No verifiable lookup:'), retained_output: { state: 'incomplete', size_bytes: bytes.length } });
    expect(fetch).toHaveBeenCalledOnce();
    const output = fs.readdirSync(workspace).filter(name => name !== 'preserved'); expect(output).toHaveLength(1);
    expect(fs.readFileSync(path.join(workspace, output[0]))).toEqual(Buffer.from(bytes));
    expect(fs.readFileSync(path.join(workspace, 'preserved'), 'utf8')).toBe('keep');
  });
  it.each(formats)('preserves raw %s bytes despite the pinned MPEG response declaration', async format => {
    const client = await setup();
    let requests = 0;
    mswServer.use(http.post('https://api.elevenlabs.io/v1/text-to-speech/:voice', ({ request }) => {
      requests++;
      expect(new URL(request.url).searchParams.get('output_format')).toBe(format);
      return new HttpResponse(bytes, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Disposition': 'attachment; filename="../../provider.mp3"' } });
    }));
    const result = await client.callTool('elevenlabs_run_job', { operation_id: 'text_to_speech_full', path_params: { voice_id: 'voice_example' }, query_params: { output_format: format }, body: { text: 'Welcome.' } });
    expect(result.isError, result.text).not.toBe(true);
    const receipt = JSON.parse(result.text);
    const [codec] = format.split('_');
    const media = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm', ulaw: 'audio/basic', alaw: 'audio/alaw', opus: 'audio/opus' }[codec];
    expect(receipt).toMatchObject({ content_type: media, data: null, follow_up_operations: [], artifact: { media_type: media, format, size_bytes: bytes.length } });
    expect(receipt).not.toHaveProperty('next_step');
    const file = receipt.artifact.file_path;
    expect(path.dirname(file)).toBe(workspace);
    expect(path.basename(file)).toMatch(new RegExp(`^elevenlabs_[a-f0-9-]+\\.${codec}$`));
    expect(fs.readFileSync(file)).toEqual(Buffer.from(bytes));
    expect(requests).toBe(1);
  });

  it.each([
    ...['audio/x-wav', 'audio/wave', 'audio/vnd.wave'].map(media => ['wav_44100', media, 'audio/wav']),
    ['opus_48000_64', 'audio/ogg', 'audio/opus'],
    ['pcm_44100', 'application/octet-stream', 'audio/pcm'],
    ['ulaw_8000', 'application/octet-stream', 'audio/basic'],
    ['alaw_8000', 'application/octet-stream', 'audio/alaw'],
  ])('accepts bound %s alias %s', async (format, media, expectedMedia) => {
    const client = await setup();
    mswServer.use(http.post('https://api.elevenlabs.io/v1/text-to-speech/:voice', () => new HttpResponse(bytes, { headers: { 'Content-Type': media } })));
    const result = await client.callTool('elevenlabs_run_job', { operation_id: 'text_to_speech_full', path_params: { voice_id: 'voice_example' }, query_params: { output_format: format }, body: { text: 'Welcome.' } });
    expect(result.isError, result.text).not.toBe(true);
    expect(result.json).toMatchObject({ artifact: { format, media_type: expectedMedia } });
    expect(fs.readFileSync((result.json as { artifact: { file_path: string } }).artifact.file_path)).toEqual(Buffer.from(bytes));
  });
  it('refuses an alias for a different bound codec', async () => {
    const client = await setup();
    mswServer.use(http.post('https://api.elevenlabs.io/v1/text-to-speech/:voice', () => new HttpResponse(bytes, { headers: { 'Content-Type': 'audio/ogg' } })));
    const result = await client.callTool('elevenlabs_run_job', { operation_id: 'text_to_speech_full', path_params: { voice_id: 'voice_example' }, query_params: { output_format: 'wav_44100' }, body: { text: 'Welcome.' } });
    expect(result.json).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
  it.each(['OUTPUT_PATH_SANDBOX_VIOLATION', 'OUTPUT_FILE_EXISTS'])('preserves writer error %s', async code => {
    const client = await setup();
    const { ElevenLabsError } = await import('../src/types.js');
    const writer = await import('../src/tools/path-safety.js');
    vi.spyOn(writer, 'writeWorkspaceArtifactStream').mockRejectedValueOnce(new ElevenLabsError('Synthetic output refusal.', code, 'Keep the existing file.'));
    mswServer.use(http.post('https://api.elevenlabs.io/v1/sound-generation', () => new HttpResponse(bytes, { headers: { 'Content-Type': 'audio/mpeg' } })));
    const result = await client.callTool('elevenlabs_run_job', { operation_id: 'sound_generation', body: { text: 'A bell.' } });
    expect(result.json).toMatchObject({ code, error: 'Synthetic output refusal.' });
  });
  it('keeps the completed paid artifact if receipt creation fails', async () => {
    const client = await setup();
    const validation = await import('../src/api-validation.js');
    vi.spyOn(validation, 'createSuccessReceipt').mockRejectedValueOnce(new Error('Synthetic receipt failure.'));
    mswServer.use(http.post('https://api.elevenlabs.io/v1/sound-generation', () => new HttpResponse(bytes, { headers: { 'Content-Type': 'audio/mpeg' } })));
    const result = await client.callTool('elevenlabs_run_job', { operation_id: 'sound_generation', body: { text: 'A bell.' } });
    expect(result.json).toMatchObject({ code: 'INVALID_RESPONSE', retained_outputs: [{ state: 'complete', size_bytes: bytes.length }] });
    const outputs = fs.readdirSync(workspace); expect(outputs).toHaveLength(1);
    expect(fs.readFileSync(path.join(workspace, outputs[0]))).toEqual(Buffer.from(bytes));
  });

  it.each(['application/octet-stream', 'audio/unknown', 'audio/mpeg, video/mp4', 'video/mp4'])('refuses undeclared or malformed %s without writing', async media => {
    const client = await setup();
    mswServer.use(http.post('https://api.elevenlabs.io/v1/sound-generation', () => new HttpResponse(bytes, { headers: { 'Content-Type': media } })));
    const result = await client.callTool('elevenlabs_run_job', { operation_id: 'sound_generation', body: { text: 'A bell.' } });
    expect(result.json).toMatchObject({ code: 'INVALID_RESPONSE', resolution: expect.stringContaining('No verifiable lookup:') });
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('does not invent a status read or automatically retry sound generation', async () => {
    const client = await setup(); let requests = 0;
    mswServer.use(http.all('https://api.elevenlabs.io/*', () => { requests++; return HttpResponse.json({ detail: 'Unavailable' }, { status: 503 }); }));
    const result = await client.callTool('elevenlabs_run_job', { operation_id: 'sound_generation', body: { text: 'A bell.' } });
    expect(result.json).toMatchObject({ code: 'HTTP_503', resolution: expect.stringContaining('No verifiable lookup: Speech history excludes sound effects') });
    expect(result.text).not.toMatch(/Check the result with|get_speech_history|subscription/);
    expect(requests).toBe(1);
  });
});

describe('descriptor-driven binary transport', () => {
  it('translates exclusive-open collisions and preserves the existing file', async () => {
    const { writeWorkspaceArtifactStream } = await import('../src/tools/path-safety.js');
    const file = path.join(workspace, 'occupied.mp3'); fs.writeFileSync(file, 'keep');
    await expect(writeWorkspaceArtifactStream('occupied.mp3', new ReadableStream(), new AbortController().signal)).rejects.toMatchObject({ code: 'OUTPUT_FILE_EXISTS' });
    expect(fs.readFileSync(file, 'utf8')).toBe('keep');
  });

  it.each([['application/zip', 'application/zip', 'zip'], ['video/mp4', 'video/mp4', 'mp4'], ['text/csv', 'text/csv', 'csv'], ['audio/*', 'audio/wav', 'wav']])('collects synthetic %s through the executor', async (declared, actual, extension) => {
    vi.resetModules();
    const source = await vi.importActual<{ apiCatalog: ApiCatalog }>('../src/generated/api-catalog.js');
    const catalog = structuredClone(source.apiCatalog);
    catalog.operations.find(op => op.operation_id === 'get_conversation_audio_route')!.responses = [{ status: 200, media_type: declared, ...(declared === 'text/csv' ? { schema: { type: 'string', format: 'binary' } } : {}) }];
    vi.doMock('../src/generated/api-catalog.js', () => ({ apiCatalog: catalog }));
    const client = await setup();
    mswServer.use(http.get('https://api.elevenlabs.io/v1/convai/conversations/:id/audio', () => new HttpResponse(bytes, { headers: { 'Content-Type': actual } })));
    const result = await client.callTool('elevenlabs_read_resource', { operation_id: 'get_conversation_audio_route', path_params: { conversation_id: 'conversation_example' } });
    expect(result.isError, result.text).not.toBe(true);
    const receipt = JSON.parse(result.text);
    expect(receipt.artifact).toMatchObject({ media_type: actual, size_bytes: bytes.length });
    expect(receipt.artifact.file_path).toMatch(new RegExp(`\\.${extension}$`));
    expect(fs.readFileSync(receipt.artifact.file_path)).toEqual(Buffer.from(bytes));
  });
});
