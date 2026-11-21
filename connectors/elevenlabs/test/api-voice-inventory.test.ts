import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { createServer } from '../src/server.js';
import * as auth from '../src/auth.js';
import * as validation from '../src/api-validation.js';
import { executeApiOperation } from '../src/api-executor.js';
import { discoverOperations, getOperation, loadApiCatalog, validateApiCatalog } from '../src/api-catalog.js';
import { createRedactor } from '../src/api-sensitive.js';
import { loadCoverageRosters, validatePolicy } from '../scripts/generate-api-catalog.mjs';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import { unwrapUntrusted } from '../src/untrusted-content.js';
import cases from './fixtures/api-voice-inventory-wire-cases.json' with { type: 'json' };

let workspace: string, pair: McpTestClient;
const wire = (id: string) => cases.find(row => row.id === id)!;
const data = (result: { text: string }) => JSON.parse(unwrapUntrusted(JSON.parse(result.text).data));
beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-inventory-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace); auth.setApiKey('synthetic-inventory-key');
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => {
  await pair.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); auth.setApiKey('');
  fs.rmSync(workspace, { recursive: true, force: true });
});

it('distinguishes collection creation from membership changes and deletion from deleting voices', async () => {
  expect(await getOperation('create_or_update_user_voice_collection')).toMatchObject({ profile: 'create', effects: { destructiveHint: false }, effect_reason: expect.stringContaining('does not add any voice') });
  expect(await getOperation('add_voice_to_user_voice_collection')).toMatchObject({ profile: 'change', effects: { destructiveHint: true }, effect_reason: expect.stringContaining('does not create a collection or voice') });
  const deleted = wire('delete_user_voice_collection'), voice = wire('get_voice_by_id');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(deleted.response)).mockResolvedValueOnce(Response.json(voice.response));
  const result = await pair.callTool('elevenlabs_delete_resource', { operation_id: deleted.id, ...deleted.args });
  expect(result.isError, result.text).not.toBe(true);
  expect(await getOperation(deleted.id)).toMatchObject({ effect_reason: expect.stringContaining('keeping its voices') });
  const read = await pair.callTool('elevenlabs_read_resource', { operation_id: voice.id, ...voice.args });
  expect(read.isError, read.text).not.toBe(true); expect(data(read)).toEqual(voice.response);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    'https://api.elevenlabs.io/v1/voices/collections/collection%2Fa%20%3F%23',
    'https://api.elevenlabs.io/v1/voices/voice%2Fa%20%3F%23?with_settings=false',
  ]);
});

it('keeps v2 opaque tokens usable without projecting an invented cursor or trusting total_count', async () => {
  const token = ' /+?&=%\u00e9 opaque token ', first = { voices: [], has_more: true, total_count: 0, next_page_token: token };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json({ ...first, has_more: false, next_page_token: null }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_user_voices_v2', query_params: { page_size: 2 } });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual(first);
  expect(JSON.parse(result.text)).not.toHaveProperty('next'); expect(data(result)).not.toHaveProperty('next_cursor');
  const next = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_user_voices_v2', query_params: { next_page_token: data(result).next_page_token, page_size: 2 } });
  expect(next.isError, next.text).not.toBe(true);
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('next_page_token')).toBe(token);
  expect(await getOperation('get_user_voices_v2')).toMatchObject({ pagination: null, manual_pagination: expect.stringContaining('unchanged') });
});

it('keeps shared-library page semantics and last_sort_id as metadata', async () => {
  const first = { voices: [], has_more: true, last_sort_id: 'opaque /+?&=% sort' };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json({ voices: [], has_more: false }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_library_voices', query_params: { page: 0, page_size: 2 } });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual(first);
  const next = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_library_voices', query_params: { page: 1, page_size: 2 } });
  expect(next.isError, next.text).not.toBe(true);
  expect([...new URL(String(fetch.mock.calls[1][0])).searchParams]).toEqual([['page', '1'], ['page_size', '2']]);
  expect(await getOperation('get_library_voices')).toMatchObject({ pagination: null, manual_pagination: expect.stringContaining('zero-based') });
});

it.each(['request', 'response', 'has_more', 'undeclared', 'cursor'] as const)('rejects incomplete or conflicting manual token metadata: %s', async missing => {
  const catalog = structuredClone(await loadApiCatalog());
  const op = catalog.operations.find(row => row.operation_id === 'get_user_voices_v2')!;
  const response = catalog.$defs.GetVoicesV2ResponseModel as { properties: Record<string, unknown> };
  if (missing === 'request') delete op.parameters.query.properties.next_page_token;
  if (missing === 'response') delete response.properties.next_page_token;
  if (missing === 'has_more') delete response.properties.has_more;
  if (missing === 'undeclared') delete op.manual_pagination;
  if (missing === 'cursor') { op.parameters.query.properties.cursor = { type: 'string' }; op.parameters.query_serialization.cursor = 'form-explode'; }
  expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
});

it('exposes the original listing limitation and the v2 alternative through discovery without I/O', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const description = await discoverOperations({ operation_id: 'get_voices' });
  expect(JSON.stringify(description)).toContain('500'); expect(JSON.stringify(description)).toContain('get_user_voices_v2');
  const contract = JSON.parse(unwrapUntrusted((description as { contract: string }).contract));
  expect(contract.description).toBe("Returns a list of all available voices for a user. Stops working once the user's workspace exceeds 500 voices.");
  expect(fetch).not.toHaveBeenCalled();
});

it('discovers the existing read-profile similarity upload with its actual file operand', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const description = await discoverOperations({ operation_id: 'get_similar_library_voices' });
  const contract = JSON.parse(unwrapUntrusted((description as { contract: string }).contract));
  expect(contract.request.files).toMatchObject([{ field: 'audio_file', kind: 'audio', required: false }]);
  expect(contract.request.body.properties).not.toHaveProperty('audio_file');
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['realtime_scribe', 'batch_scribe', 'tts_websocket'])('issues only one %s credential, only in success data, and starts no connection', async token_type => {
  const token = 'example-issued-single-use-credential', logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ token, other: { token, api_key: 'stored-secret' } }));
  const result = await pair.callTool('elevenlabs_create_resource', { operation_id: 'get_single_use_token', path_params: { token_type } });
  expect(result.isError, result.text).not.toBe(true);
  expect(data(result)).toEqual({ token, other: { token: '[REDACTED]', api_key: '[REDACTED]' } });
  const { data: _data, ...diagnostics } = JSON.parse(result.text);
  expect(JSON.stringify(diagnostics)).not.toContain(token); expect(JSON.stringify(logs.mock.calls)).not.toContain(token);
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][0]).toBe(`https://api.elevenlabs.io/v1/single-use-token/${token_type}`);
});

it('keeps the exact token enum and rejects invented types before dispatch', async () => {
  const op = await getOperation('get_single_use_token'), catalog = await loadApiCatalog();
  expect(catalog.$defs.SingleUseTokenType).toMatchObject({ enum: ['realtime_scribe', 'batch_scribe', 'tts_websocket'] });
  expect(op.credential_return_fields).toEqual([['token']]);
  const fetch = vi.spyOn(globalThis, 'fetch');
  const result = await pair.callTool('elevenlabs_create_resource', { operation_id: op.operation_id, path_params: { token_type: 'realtime' } });
  expect(result.isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
});

it('requires the credential-return declaration at generation and loading', async () => {
  const policy = structuredClone(policyInput);
  delete (policy.operations.get_single_use_token as { credential_return_fields?: string[][] }).credential_return_fields;
  const rosters = await loadCoverageRosters(path.resolve(import.meta.dirname, '..'));
  expect(() => validatePolicy(policy, rosters)).toThrow('missing credential return fields');
  const catalog = structuredClone(await loadApiCatalog());
  delete catalog.operations.find(op => op.operation_id === 'get_single_use_token')!.credential_return_fields;
  expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
});

it.each([401, 422, 500])('omits credential echoes from HTTP %s errors and logs without retry', async status => {
  const token = 'example-error-single-use-credential', logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ detail: { message: token, token } }, { status }));
  const result = await pair.callTool('elevenlabs_create_resource', { operation_id: 'get_single_use_token', path_params: { token_type: 'realtime_scribe' } });
  expect(result.isError).toBe(true); expect(result.text).not.toContain(token); expect(JSON.stringify(logs.mock.calls)).not.toContain(token); expect(fetch).toHaveBeenCalledOnce();
});

it('keeps credential schema-mismatch details out of diagnostics and scrubs an issued API key', async () => {
  const token = 'example-mismatch-credential';
  const receipt = await validation.createSuccessReceipt('get_single_use_token', 200, 'application/json', { token: { [token]: true } }, createRedactor([]));
  const { data: _data, ...diagnostics } = receipt;
  expect(receipt.data).toContain(token); expect(JSON.stringify(diagnostics)).not.toContain(token);
  const masked = await validation.createSuccessReceipt('get_single_use_token', 200, 'application/json', { token }, createRedactor([token]));
  expect(masked.data).not.toContain(token); expect(masked.data).toContain('[REDACTED]');
});

it('redacts the stored account key preview with the single redactor', async () => {
  const preview = 'example-stored-key-preview';
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ ...wire('get_user_info').response as object, xi_api_key_preview: preview }));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_user_info' });
  expect(result.isError, result.text).not.toBe(true); expect(data(result).xi_api_key_preview).toBe('[REDACTED]');
  expect(result.text).not.toContain(preview); expect(fetch).toHaveBeenCalledOnce();
});

it('saves the selected preview and reads the permanent voice back without another generation', async () => {
  const saved = wire('create_voice'), read = wire('get_voice_by_id');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(saved.response)).mockResolvedValueOnce(Response.json(saved.response));
  const created = await pair.callTool('elevenlabs_create_resource', { operation_id: saved.id, ...saved.args });
  expect(created.isError, created.text).not.toBe(true); expect(data(created)).toEqual(saved.response);
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: read.id, path_params: { voice_id: data(created).voice_id } });
  expect(result.isError, result.text).not.toBe(true); expect(data(result)).toEqual(saved.response);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://api.elevenlabs.io/v1/text-to-voice', 'https://api.elevenlabs.io/v1/voices/voice_example']);
});

it('streams preview bytes directly to an MP3 file and reports completed progress', async () => {
  const bytes = Buffer.from([0x49, 0x44, 0x33, 0, 255, 12]), notifications: unknown[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg', 'undeclared': 'hidden', 'Content-Disposition': 'filename=unsafe.mp3' } }));
  const receipt = await executeApiOperation('read', { operation_id: 'text_to_voice_preview_stream', path_params: { generated_voice_id: 'generated_first' } }, undefined, undefined, { progressToken: 1, sendNotification: async notification => { notifications.push(notification); } });
  expect(receipt.artifact).toMatchObject({ size_bytes: bytes.length, media_type: 'audio/mpeg', file_path: expect.stringMatching(/\.mp3$/) });
  expect(fs.readFileSync(receipt.artifact!.file_path)).toEqual(bytes); expect(receipt.data).toBeNull(); expect(receipt.metadata).toBeUndefined();
  expect(JSON.stringify(notifications)).toContain('complete'); expect(fetch).toHaveBeenCalledOnce();
});

it.each([false, true])('treats a broken preview stream like other binary reads, progress=%s, without retry', async withProgress => {
  let pull = 0;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (pull++ === 0) controller.enqueue(Buffer.from('prefix')); else controller.error(new Error('synthetic transport failure'));
  } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'audio/mpeg' } }));
  const failure = await executeApiOperation('read', { operation_id: 'text_to_voice_preview_stream', path_params: { generated_voice_id: 'generated_first' } }, undefined, undefined, withProgress ? { progressToken: 1, sendNotification: async () => {} } : undefined).catch((error: unknown) => error) as { retained_output?: unknown; retained_outputs?: unknown };
  expect(failure.retained_outputs).toBeUndefined(); expect(fetch).toHaveBeenCalledOnce();
  if (withProgress) { // A file already announced through progress stays, marked incomplete.
    expect(failure.retained_output).toMatchObject({ state: 'incomplete', size_bytes: 6 });
    expect(fs.readFileSync(path.join(workspace, fs.readdirSync(workspace)[0]), 'utf8')).toBe('prefix');
  } else { expect(failure.retained_output).toBeUndefined(); expect(fs.readdirSync(workspace)).toEqual([]); }
});

it('removes a finished preview file after receipt failure like other binary reads', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('finished', { headers: { 'Content-Type': 'audio/mpeg' } }));
  vi.spyOn(validation, 'createSuccessReceipt').mockRejectedValueOnce(new Error('synthetic receipt failure'));
  const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'text_to_voice_preview_stream', path_params: { generated_voice_id: 'generated_first' } });
  expect(result.isError).toBe(true); expect(JSON.parse(result.text).retained_outputs).toBeUndefined();
  expect(fs.readdirSync(workspace)).toEqual([]); expect(fetch).toHaveBeenCalledOnce();
});
