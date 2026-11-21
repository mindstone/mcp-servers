import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { apiCatalog } from '../src/generated/api-catalog.js';
import { describeOperation, loadApiCatalog, type ApiOperation } from '../src/api-catalog.js';
import { executeApiOperation } from '../src/api-executor.js';
import { binaryFileShape } from '../src/api-multipart-shapes.mjs';
import { setApiKey } from '../src/auth.js';
import { mimeTypeForFileName, readSandboxedFile } from '../src/tools/file-input.js';
import { createInMemoryTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import processing from './fixtures/api-processing-wire-cases.json' with { type: 'json' };
import pvc from './fixtures/api-pvc-wire-cases.json' with { type: 'json' };
import music from './fixtures/api-music-wire-cases.json' with { type: 'json' };
import supporting from './fixtures/api-supporting-wire-cases.json' with { type: 'json' };
import dubbing from './fixtures/api-dubbing-wire-cases.json' with { type: 'json' };
import legacyDubbing from './fixtures/api-legacy-dubbing-wire-cases.json' with { type: 'json' };

vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));

const wires = [...processing, ...pvc, ...music, ...supporting, ...dubbing, ...legacyDubbing];
const targets = ['add_pvc_voice_samples.files', 'add_voice.files', 'audio_isolation.audio', 'audio_isolation_stream.audio',
  'create_dubbing.background_audio_file', 'create_dubbing.file', 'create_dubbing.foreground_audio_file', 'create_finetune.files',
  'dubbing_project_create.file', 'edit_voice.files', 'forced_alignment.file', 'separate_song_stems.file',
  'speech_to_speech_full.audio', 'speech_to_speech_stream.audio', 'speech_to_text.file', 'upload_song.file'];
const pcmIds = ['audio_isolation', 'audio_isolation_stream', 'speech_to_speech_full', 'speech_to_speech_stream', 'speech_to_text'];
let workspace: string;
beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audio-types-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace); setApiKey('synthetic-upload-key');
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); setApiKey('');
  fs.rmSync(workspace, { recursive: true, force: true });
});

function args(op: ApiOperation, field: string, file: string, pcm = false) {
  const wire = wires.find(row => row.id === op.operation_id)!;
  const binding = op.request.files!.find(binding => binding.field === field)!;
  return { ...wire.args, operation_id: op.operation_id,
    ...(pcm ? { body: { ...wire.args.body, file_format: 'pcm_s16le_16' } } : {}),
    files: [{ field, ...(binaryFileShape(binding.schema)!.multiple ? { file_paths: [file] } : { file_path: file }) }] };
}
function respond(id: string, field: string, bytes: Buffer, mime: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const form = await new Request(String(url), options as RequestInit).formData();
    const file = form.get(field) as File;
    expect(file.type).toBe(mime); expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    if (mime === 'audio/pcm') expect(form.get('file_format')).toBe('pcm_s16le_16');
    const op = wires.find(row => row.id === id)!;
    return op.media === 'application/json' ? Response.json(op.response, { status: op.status })
      : new Response(String(op.response), { status: op.status, headers: { 'Content-Type': op.media } });
  });
}

it('checks all sixteen audio bindings before opening or fetching and still sends exact MP3 bytes', async () => {
  const catalog = await loadApiCatalog();
  expect(catalog).toEqual(apiCatalog);
  // A 100 ms mono silence recording encoded as MP3.
  const bytes = Buffer.from('//MoxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MoxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MoxLEAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV', 'base64');
  const source = path.join(workspace, 'sample.mp3'); fs.writeFileSync(source, bytes);
  for (const target of targets) {
    const [id, field] = target.split('.'); const op = catalog.operations.find(op => op.operation_id === id)!;
    const fetch = vi.spyOn(globalThis, 'fetch'); const open = vi.spyOn(fs.promises, 'open');
    for (const name of ['notes', 'package.json']) {
      const file = path.join(workspace, name); fs.writeFileSync(file, 'ordinary text');
      await expect(executeApiOperation(op.profile, args(op, field, file)), target).rejects.toMatchObject({
        code: 'INVALID_FILE_TYPE', resolution: expect.stringContaining('audio or video file (mp3, wav, m4a, ogg, flac, webm, mp4, mov'),
      });
    }
    expect(open, target).not.toHaveBeenCalled(); expect(fetch, target).not.toHaveBeenCalled();
    vi.restoreAllMocks(); const dispatch = respond(id, field, bytes, 'audio/mpeg');
    await executeApiOperation(op.profile, args(op, field, source)); expect(dispatch, target).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    const discovered = JSON.parse((await describeOperation(id)).contract.replace(/^<untrusted-content[^>]*>\n?/, '').replace(/\n?<\/untrusted-content>$/, ''));
    expect(discovered.request.files.find((file: { field: string }) => file.field === field).allowed_media_types).toContain('audio/mpeg');
  }
});

it('allows raw PCM only on the five declaring request contracts and sends its exact bytes and MIME', async () => {
  const catalog = await loadApiCatalog(); const bytes = Buffer.from([0, 128, 255, 127]);
  const source = path.join(workspace, 'sample.pcm'); fs.writeFileSync(source, bytes);
  for (const target of targets) {
    const [id, field] = target.split('.'); const op = catalog.operations.find(op => op.operation_id === id)!;
    const dispatch = respond(id, field, bytes, 'audio/pcm');
    if (pcmIds.includes(id)) {
      await executeApiOperation(op.profile, args(op, field, source, true)); expect(dispatch).toHaveBeenCalledOnce();
    } else {
      await expect(executeApiOperation(op.profile, args(op, field, source))).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
      expect(dispatch).not.toHaveBeenCalled();
    }
    vi.restoreAllMocks();
  }
});

it('preserves the three explicit media lists and legacy acceptance of unknown extensions', async () => {
  const catalog = await loadApiCatalog();
  const expected = {
    post_agent_hold_audio_route: ['audio/mpeg', 'audio/wav'],
    get_similar_library_voices: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg', 'audio/flac'],
    video_to_music: ['video/mp4', 'video/webm', 'video/quicktime'],
  };
  for (const [id, media] of Object.entries(expected)) {
    const binding = catalog.operations.find(op => op.operation_id === id)!.request.files![0];
    expect(binding.allowed_media_types).toEqual(media);
    for (const [extension, mime] of [['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['m4a', 'audio/mp4'], ['ogg', 'audio/ogg'],
      ['flac', 'audio/flac'], ['mp4', 'video/mp4'], ['webm', 'video/webm'], ['mov', 'video/quicktime'], ['pcm', 'audio/pcm'], ['json', 'application/octet-stream']]) {
      const source = path.join(workspace, `sample.${extension}`); fs.writeFileSync(source, 'sample');
      if (media.includes(mime)) expect(readSandboxedFile(source, undefined, [], 'audio', binding).buffer.toString()).toBe('sample');
      else expect(() => readSandboxedFile(source, undefined, [], 'audio', binding)).toThrowError(expect.objectContaining({ code: 'INVALID_FILE_TYPE' }));
    }
  }
  const source = path.join(workspace, 'sample.unknown'); fs.writeFileSync(source, 'legacy bytes');
  expect(readSandboxedFile(source).buffer.toString()).toBe('legacy bytes');
  expect(mimeTypeForFileName(source)).toBe('audio/mpeg');
  expect(mimeTypeForFileName('sample.pcm')).toBe('audio/pcm');
  const client = await createInMemoryTestClient({ createServer });
  const dispatch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const form = await new Request(String(url), options as RequestInit).formData();
    const file = form.get('file') as File;
    expect(file.type).toBe('audio/mpeg'); expect(await file.text()).toBe('legacy bytes');
    return Response.json({ language_code: 'en', language_probability: 1, text: 'A recording.', words: [] });
  });
  try {
    const result = await client.callTool('transcribe_audio', { file_path: source });
    expect(result.isError, result.text).not.toBe(true); expect(dispatch).toHaveBeenCalledOnce();
  } finally { await client.close(); }
});
