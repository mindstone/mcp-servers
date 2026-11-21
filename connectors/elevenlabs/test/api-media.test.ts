import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { binaryRepresentation, audioRepresentation } from '../src/api-media.mjs';
import { writeWorkspaceArtifactStream } from '../src/tools/path-safety.js';
import { executeApiOperation } from '../src/api-executor.js';
import { setApiKey } from '../src/auth.js';
import type { ApiCatalog } from '../src/api-catalog.js';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'binary-media-')));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setApiKey(''); vi.doUnmock('../src/generated/api-catalog.js'); vi.resetModules(); });
import { afterAll } from 'vitest';
afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));
function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.subarray(0, 2)); controller.enqueue(bytes.subarray(2)); controller.close(); } });
}

describe('checked binary representations', () => {
  it.each(['application/zip', 'application/x-zip'])('retains declared %s and exact bytes through the executor', async media_type => {
    vi.resetModules();
    const actual = await vi.importActual<{ apiCatalog: ApiCatalog }>('../src/generated/api-catalog.js');
    const raw = structuredClone(actual.apiCatalog);
    const op = raw.operations.find(op => op.operation_id === 'get_conversation_audio_route')!;
    op.responses = [{ status: 200, media_type, schema: { type: 'string', format: 'binary' } }];
    vi.doMock('../src/generated/api-catalog.js', () => ({ apiCatalog: raw }));
    const { executeApiOperation: execute } = await import('../src/api-executor.js');
    const { setApiKey: setKey } = await import('../src/auth.js');
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
    setKey('synthetic-archive-key');
    const bytes = new Uint8Array([80, 75, 0, 255, 13, 10]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': media_type } }));
    try {
      const receipt = await execute('read', { operation_id: op.operation_id, path_params: { conversation_id: 'conversation_example' } });
      expect(receipt.content_type).toBe(media_type);
      const artifact = receipt.artifact!;
      expect(artifact.file_path).toMatch(/\.zip$/);
      expect(artifact.media_type).toBe(media_type);
      expect(fs.readFileSync(artifact.file_path)).toEqual(Buffer.from(bytes));
    } finally { setKey(''); }
  });

  it.each([
    ['audio/mpeg', 'mp3'], ['audio/wav', 'wav'], ['audio/pcm', 'pcm'], ['audio/basic', 'ulaw'],
    ['audio/alaw', 'alaw'], ['audio/opus', 'opus'], ['application/zip', 'zip'], ['application/x-zip', 'zip'], ['audio/x-wav', 'wav'], ['audio/ulaw', 'ulaw'], ['audio/ogg', 'ogg'], ['text/plain', 'txt'], ['text/csv', 'csv'], ['video/mp4', 'mp4'],
  ])('writes byte-exact %s incrementally', async (media_type, extension) => {
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
    const representation = binaryRepresentation({ media_type, schema: { type: 'string', format: 'binary' } }, media_type, undefined);
    expect(representation).toEqual({ media_type, extension });
    const bytes = new Uint8Array([0, 255, 82, 73, 70, 70]);
    const artifact = await writeWorkspaceArtifactStream(`test-${media_type.replaceAll('/', '-')}.${extension}`, stream(bytes), new AbortController().signal);
    expect(artifact.size_bytes).toBe(bytes.length);
    expect(fs.readFileSync(artifact.file_path)).toEqual(Buffer.from(bytes));
    expect(path.dirname(artifact.file_path)).toBe(workspace);
  });

  it('supports only known concrete wildcard audio and explicit format-selected MPEG bindings', () => {
    expect(binaryRepresentation({ media_type: 'audio/*' }, 'audio/wav', undefined)).toEqual({ media_type: 'audio/wav', extension: 'wav' });
    expect(binaryRepresentation({ media_type: 'audio/*' }, 'audio/made-up', undefined)).toBeUndefined();
    const descriptor = { media_type: 'audio/mpeg', output_formats: { default: 'mp3_44100_128', values: ['mp3_44100_128', 'pcm_16000', 'wav_44100', 'ulaw_8000', 'alaw_8000', 'opus_48000_128'] } };
    for (const format of descriptor.output_formats.values) {
      const representation = audioRepresentation(format)!;
      expect(binaryRepresentation(descriptor, 'audio/mpeg', format)).toMatchObject(representation);
      expect(binaryRepresentation(descriptor, representation.media_type, format)).toMatchObject(representation);
    }
    expect(binaryRepresentation(descriptor, 'video/mp4', 'wav_44100')).toBeUndefined();
    expect(binaryRepresentation(descriptor, 'audio/wav', 'unknown')).toBeUndefined();
    expect(binaryRepresentation({ media_type: 'audio/mpeg' }, 'audio/wav', undefined)).toBeUndefined();
    expect(binaryRepresentation({ media_type: 'audio/mpeg' }, 'application/octet-stream', undefined)).toBeUndefined();
  });
});

describe('incremental artifact ownership and cleanup', () => {
  it('refuses unknown provider media before writing anything', async () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
    setApiKey('synthetic-media-key');
    const before = fs.readdirSync(workspace);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(new Uint8Array([0, 255]), { headers: { 'Content-Type': 'application/unknown' } }));
    await expect(executeApiOperation('read', { operation_id: 'get_conversation_audio_route', path_params: { conversation_id: 'conversation_example' } })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fs.readdirSync(workspace)).toEqual(before);
  });

  it('honours host cancellation through the executor while collecting a body', async () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
    setApiKey('synthetic-cancellation-key');
    const before = fs.readdirSync(workspace);
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } }));
    const pending = executeApiOperation('read', { operation_id: 'get_conversation_audio_route', path_params: { conversation_id: 'conversation_example' } }, undefined, abort.signal);
    setTimeout(() => abort.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', resolution: expect.stringContaining('Cancellation does not undo provider effects.') });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fs.readdirSync(workspace)).toEqual(before);
  });
  it('removes only the new partial file on read failure', async () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
    const preserved = path.join(workspace, 'preserved'); fs.writeFileSync(preserved, 'keep');
    let chunks = 0;
    const broken = new ReadableStream<Uint8Array>({ pull(controller) {
      if (chunks++ === 0) controller.enqueue(new Uint8Array([1, 2]));
      else controller.error(new Error('Synthetic body failure'));
    } });
    await expect(writeWorkspaceArtifactStream('partial', broken, new AbortController().signal)).rejects.toThrow();
    expect(fs.existsSync(path.join(workspace, 'partial'))).toBe(false);
    expect(fs.readFileSync(preserved, 'utf8')).toBe('keep');
    await expect(writeWorkspaceArtifactStream('preserved', stream(new Uint8Array([7])), new AbortController().signal)).rejects.toThrow();
    expect(fs.readFileSync(preserved, 'utf8')).toBe('keep');
  });

  it('cancels a pending read and removes the partial file', async () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel });
    const writing = writeWorkspaceArtifactStream('cancelled', body, abort.signal);
    setTimeout(() => abort.abort(), 20);
    await expect(writing).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(workspace, 'cancelled'))).toBe(false);
  });

  it('refuses output escapes and planted symlinks', async () => {
    vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
    await expect(writeWorkspaceArtifactStream('../escape', stream(new Uint8Array()), new AbortController().signal)).rejects.toMatchObject({ code: 'OUTPUT_PATH_SANDBOX_VIOLATION' });
    const planted = path.join(workspace, 'planted');
    fs.symlinkSync(path.join(workspace, 'preserved'), planted);
    await expect(writeWorkspaceArtifactStream('planted', stream(new Uint8Array()), new AbortController().signal)).rejects.toThrow();
    expect(fs.lstatSync(planted).isSymbolicLink()).toBe(true);
  });
});
