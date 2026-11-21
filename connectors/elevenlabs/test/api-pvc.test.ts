import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import * as auth from '../src/auth.js';
import * as validation from '../src/api-validation.js';
import { executeApiOperation } from '../src/api-executor.js';
import { getOperation } from '../src/api-catalog.js';
import { FILE_READ_CAPABILITIES } from '../src/file-read-context.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import policy from '../api/operation-policy.json' with { type: 'json' };
import cases from './fixtures/api-pvc-wire-cases.json' with { type: 'json' };
import inventory from './fixtures/api-voice-inventory-wire-cases.json' with { type: 'json' };

let workspace: string, pair: McpTestClient;
const data = (result: { text: string }) => JSON.parse(unwrapUntrusted(JSON.parse(result.text).data));
beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pvc-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace); auth.setApiKey('test-key-1');
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => {
  await pair.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); auth.setApiKey('');
  fs.rmSync(workspace, { recursive: true, force: true });
});

it.each(cases.filter(row => row.multipart))('$id preserves repeated file operands in order and performs no follow-up calls', async wire => {
  const part = wire.multipart!, forms: FormData[] = [];
  const paths = ['first', 'second'].map(name => path.join(workspace, `${name}${path.extname(part.fileName)}`));
  paths.forEach((file, index) => fs.writeFileSync(file, Buffer.from([...part.bytes, index])));
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (url, options) => {
    expect(String(url)).toBe(`https://api.elevenlabs.io${wire.path}`);
    expect(options?.method).toBe('POST'); expect(options?.redirect).toBe('manual');
    forms.push(await new Request(String(url), options as RequestInit).formData());
    return Response.json(wire.response);
  });
  const result = await pair.callTool(`elevenlabs_${wire.profile}_resource`, { operation_id: wire.id, ...wire.args, files: [{ field: 'files', file_paths: paths }] });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual(wire.response);
  expect(fetch).toHaveBeenCalledOnce();
  const form = forms[0];
  expect([...form.keys()]).toEqual([...part.scalars.map(([key]) => key), 'files', 'files']);
  const files = form.getAll('files') as File[];
  for (const [index, file] of files.entries()) {
    expect(file.name).toBe(path.basename(paths[index])); expect(file.type).toBe(part.mime);
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...part.bytes, index]);
  }
  for (const [key, value] of part.scalars) expect(form.get(key)).toBe(value);
});

it.each(['add_voice', 'edit_voice'])('%s keeps object labels JSON-encoded once and string labels unchanged', async id => {
  const forms: FormData[] = [], file = path.join(workspace, 'sample.wav'); fs.writeFileSync(file, 'sample');
  const wire = cases.find(row => row.id === id)!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    forms.push(await new Request(String(url), options as RequestInit).formData()); return Response.json(wire.response);
  });
  for (const labels of [{ language: 'en', accent: 'neutral' }, '{ "language": "en" }']) {
    const result = await pair.callTool(`elevenlabs_${wire.profile}_resource`, { operation_id: id, ...wire.args, body: { name: 'Acme narrator', labels }, files: [{ field: 'files', file_paths: [file] }] });
    expect(result.isError, result.text).not.toBe(true);
  }
  expect(forms.map(form => form.get('labels'))).toEqual(['{"language":"en","accent":"neutral"}', '{ "language": "en" }']);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(cases.filter(row => row.multipart))('$id requires authorization for each concrete repeated operand', async wire => {
  await pair.close(); pair = await createInMemoryTestClient({ createServer, clientCapabilities: FILE_READ_CAPABILITIES });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pvc-authorized-'));
  try {
    const paths = ['first', 'second'].map(name => path.join(outside, `${name}${path.extname(wire.multipart!.fileName)}`));
    paths.forEach(file => fs.writeFileSync(file, 'sample'));
    const args = { operation_id: wire.id, ...wire.args, files: [{ field: 'files', file_paths: paths }] };
    const reads = paths.map((rawPath, index) => ({ location: ['files', 0, 'file_paths', index], rawPath, canonicalPath: fs.realpathSync(rawPath) }));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      expect((await new Request(String(url), options as RequestInit).formData()).getAll('files')).toHaveLength(2);
      return Response.json(wire.response);
    });
    const call = (authorized: typeof reads) => pair.client.callTool({ name: `elevenlabs_${wire.profile}_resource`, arguments: args, _meta: { 'files/readMode': { version: 1, mode: 'central', reads: authorized } } });
    const missing = await call(reads.slice(0, 1)); expect(missing.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
    const wrongIndex = await call(reads.map(read => ({ ...read, location: ['files', 1, ...read.location.slice(2)] })));
    expect(wrongIndex.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
    const result = await call(reads); expect(result.isError, JSON.stringify(result)).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

it.each(cases.filter(row => row.multipart))('$id refuses outside-workspace files in standalone mode and scalar file operands', async wire => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pvc-outside-'));
  try {
    const file = path.join(outside, wire.multipart!.fileName); fs.writeFileSync(file, 'sample');
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const files of [[{ field: 'files', file_paths: [file] }], [{ field: 'files', file_path: file }]]) {
      const result = await pair.callTool(`elevenlabs_${wire.profile}_resource`, { operation_id: wire.id, ...wire.args, files });
      expect(result.isError).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

it.each(['not_started', 'pending', 'completed', 'failed'])('returns separation state %s without starting, training or polling', async status => {
  const wire = cases.find(row => row.id === 'get_pvc_sample_speakers')!;
  const response = { ...wire.response as object, status };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(response));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: wire.id, ...wire.args });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual(response); expect(fetch).toHaveBeenCalledOnce();
});

it.each(['not_started', 'queued', 'fine_tuning', 'fine_tuned', 'failed', 'delayed'])('preserves training state %s from an explicit voice read', async state => {
  const response = { ...inventory.find(row => row.id === 'get_voice_by_id')!.response as object,
    fine_tuning: { is_allowed_to_fine_tune: true, state: { eleven_multilingual_v2: state }, verification_failures: [], verification_attempts_count: 0, manual_verification_requested: false } };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(response));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_voice_by_id', path_params: { voice_id: 'voice_example' } });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual(response); expect(fetch).toHaveBeenCalledOnce();
});

it('submits scanned and PDF verification documents with their own media types', async () => {
  const scan = path.join(workspace, 'identity.jpg'), pdf = path.join(workspace, 'identity.pdf');
  fs.writeFileSync(scan, 'example scan'); fs.writeFileSync(pdf, '%PDF-example');
  const forms: FormData[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (url, options) => {
    forms.push(await new Request(String(url), options as RequestInit).formData()); return Response.json({ status: 'ok' });
  });
  const result = await pair.callTool('elevenlabs_change_resource', { operation_id: 'request_pvc_manual_verification', path_params: { voice_id: 'voice_example' }, files: [{ field: 'files', file_paths: [scan, pdf] }] });
  expect(result.isError, result.text).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
  expect((forms[0].getAll('files') as File[]).map(file => `${file.name}:${file.type}`)).toEqual(['identity.jpg:image/jpeg', 'identity.pdf:application/pdf']);
});

it('submits manual verification as a change without claiming approval or starting training', async () => {
  const file = path.join(workspace, 'verification.pdf'); fs.writeFileSync(file, '%PDF-example');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ status: 'ok' }));
  const result = await pair.callTool('elevenlabs_change_resource', { operation_id: 'request_pvc_manual_verification', path_params: { voice_id: 'voice_example' }, files: [{ field: 'files', file_paths: [file] }] });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual({ status: 'ok' });
  expect(JSON.parse(result.text)).toMatchObject({ effects: { readOnlyHint: false, destructiveHint: true }, next_step: expect.stringContaining('get_voice_by_id') });
  expect(result.text).not.toMatch(/approved|verified|training completed/i); expect(fetch).toHaveBeenCalledOnce();
  expect(await getOperation('request_pvc_manual_verification')).toMatchObject({ effect_reason: expect.stringContaining('submission is not approval') });
  const response = { ...inventory.find(row => row.id === 'get_voice_by_id')!.response as object,
    fine_tuning: { is_allowed_to_fine_tune: false, state: { eleven_multilingual_v2: 'not_started' }, verification_failures: [], verification_attempts_count: 0, manual_verification_requested: true },
    voice_verification: { requires_verification: true, is_verified: false, verification_failures: [], verification_attempts_count: 0 } };
  fetch.mockResolvedValueOnce(Response.json(response));
  const read = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_voice_by_id', path_params: { voice_id: 'voice_example' } });
  expect(read.isError, read.text).not.toBe(true); expect(data(read)).toEqual(response); expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['edit_pvc_voice', 'edit_pvc_voice_sample', 'run_pvc_voice_training'])('%s preserves an omitted optional JSON body', async id => {
  const wire = cases.find(row => row.id === id)!;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(wire.response));
  const result = await pair.callTool('elevenlabs_change_resource', { operation_id: id, path_params: wire.args.path_params });
  expect(result.isError, result.text).not.toBe(true); expect(fetch.mock.calls[0][1]?.body).toBeUndefined(); expect(fetch).toHaveBeenCalledOnce();
});

it('edits voice metadata without adding any optional recordings', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (url, options) => {
    const form = await new Request(String(url), options as RequestInit).formData();
    expect([...form.entries()]).toEqual([['name', 'Acme narrator']]); return Response.json({ status: 'ok' });
  });
  const result = await pair.callTool('elevenlabs_change_resource', { operation_id: 'edit_voice', path_params: { voice_id: 'voice_example' }, body: { name: 'Acme narrator' } });
  expect(result.isError, result.text).not.toBe(true); expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  ['audio/mpeg', 'mp3'], ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/pcm', 'pcm'],
  ['audio/basic', 'ulaw'], ['audio/ulaw', 'ulaw'], ['audio/alaw', 'alaw'], ['audio/opus', 'opus'], ['audio/ogg', 'ogg'],
])('saves wildcard sample media %s with the shared concrete extension %s', async (media, extension) => {
  const bytes = Buffer.from([0, 255, 128, 10]);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': media, 'Content-Disposition': 'attachment; filename=unsafe.exe', 'request-id': 'undeclared' } }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_audio_from_sample', path_params: { voice_id: 'voice_example', sample_id: 'sample_example' } });
  expect(result.isError, result.text).not.toBe(true);
  const receipt = JSON.parse(result.text); expect(receipt.artifact).toMatchObject({ media_type: media, size_bytes: 4, file_path: expect.stringMatching(new RegExp(`\\.${extension}$`)) });
  expect(fs.readFileSync(receipt.artifact.file_path)).toEqual(bytes); expect(receipt.metadata).toBeUndefined(); expect(fetch).toHaveBeenCalledOnce();
});

it.each(['audio/*', 'audio/flac', 'audio/wave', 'application/octet-stream'])('refuses unlisted wildcard media %s without inventing an extension', async media => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('sample', { headers: { 'Content-Type': media } }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_audio_from_sample', path_params: { voice_id: 'voice_example', sample_id: 'sample_example' } });
  expect(result.isError).toBe(true); expect(fs.readdirSync(workspace)).toEqual([]);
});

it.each([false, true])('keeps only announced partial sample reads, progress=%s', async progress => {
  let count = 0;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) {
    if (count++ === 0) controller.enqueue(Buffer.from('prefix')); else controller.error(new Error('synthetic stream failure'));
  } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'audio/mpeg' } }));
  const error = await executeApiOperation('read', { operation_id: 'get_audio_from_sample', path_params: { voice_id: 'voice_example', sample_id: 'sample_example' } }, undefined, undefined,
    progress ? { progressToken: 1, sendNotification: async () => {} } : undefined).catch((error: unknown) => error) as { retained_output?: { state: string; size_bytes: number } };
  if (progress) expect(error.retained_output).toMatchObject({ state: 'incomplete', size_bytes: 6 });
  else { expect(error.retained_output).toBeUndefined(); expect(fs.readdirSync(workspace)).toEqual([]); }
  expect(fetch).toHaveBeenCalledOnce();
});

it('cleans up an unannounced finished sample read after receipt failure', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('finished', { headers: { 'Content-Type': 'audio/mpeg' } }));
  vi.spyOn(validation, 'createSuccessReceipt').mockRejectedValueOnce(new Error('synthetic receipt failure'));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_audio_from_sample', path_params: { voice_id: 'voice_example', sample_id: 'sample_example' } });
  expect(result.isError).toBe(true); expect(fs.readdirSync(workspace)).toEqual([]);
});

it.each(['get_pvc_voice_captcha', 'verify_pvc_voice_captcha'] as const)('keeps %s planned with the unresolved representation reason and zero I/O', async id => {
  expect(policy.operations[id]).toMatchObject({ status: 'planned', milestone: 9, profile: null, reason: expect.stringContaining('No reviewed response override exists') });
  const fetch = vi.spyOn(globalThis, 'fetch'), key = vi.spyOn(auth, 'getApiKey');
  const result = await pair.callTool(id.startsWith('get_') ? 'elevenlabs_read_resource' : 'elevenlabs_change_resource', { operation_id: id, path_params: { voice_id: 'voice_example' } });
  expect(JSON.parse(result.text)).toMatchObject({ ok: false, code: 'UNKNOWN_OPERATION' }); expect(fetch).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
});

it.each(cases.filter(row => row.profile !== 'read'))('$id failure neither retries nor triggers training, verification or deletion', async wire => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ detail: 'Synthetic failure' }, { status: 503 }));
  let files;
  if (wire.multipart) { const file = path.join(workspace, wire.multipart.fileName); fs.writeFileSync(file, 'sample'); files = [{ field: 'files', file_paths: [file] }]; }
  const result = await pair.callTool(`elevenlabs_${wire.profile}_resource`, { operation_id: wire.id, ...wire.args, ...(files ? { files } : {}) });
  expect(result.isError).toBe(true); expect(result.text).not.toMatch(/no charge|not charged|no credits/i); expect(fetch).toHaveBeenCalledOnce();
  const op = await getOperation(wire.id); for (const id of op.follow_ups) expect((await getOperation(id)).profile).toBe('read');
});
