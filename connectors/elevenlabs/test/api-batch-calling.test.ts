import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as auth from '../src/auth.js';
import * as fileInput from '../src/tools/file-input.js';
import { createServer } from '../src/server.js';
import { discoverOperations, getOperation } from '../src/api-catalog.js';
import { validateRequest } from '../src/api-validation.js';
import { createRedactor } from '../src/api-sensitive.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import cases from './fixtures/api-batch-calling-wire-cases.json' with { type: 'json' };
import { mswServer } from './helpers/setup.js';

const submit = cases.find(wire => wire.id === 'create_batch_call')!;
let pair: McpTestClient;
let workspace: string;
beforeEach(async () => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'api-batch-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  auth.setApiKey('example-connector-credential');
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => { await pair.close(); auth.setApiKey(''); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(workspace, { recursive: true, force: true }); });

describe('complete batch calling', () => {
  it.each([false, true])('preserves caller-owned JSON recipients, controls and WhatsApp alternative %s', async whatsapp => {
    const body = structuredClone(submit.body!);
    if (whatsapp) {
      body.agent_phone_number_id = null;
      body.whatsapp_params = { whatsapp_phone_number_id: 'wa_guide', whatsapp_call_permission_request_template_name: 'guide_call_permission', whatsapp_call_permission_request_template_language_code: 'en' };
      body.recipients = [{ id: 'person_example', phone_number: null, whatsapp_user_id: '12025550101', conversation_initiation_client_data: body.recipients[0].conversation_initiation_client_data }];
    }
    const original = structuredClone(body);
    let received: unknown;
    const dispatch = vi.fn(async ({ request }: { request: Request }) => { received = await request.json(); return HttpResponse.json(submit.response); });
    mswServer.use(http.post('https://api.elevenlabs.io/v1/convai/batch-calling/submit', dispatch));
    const result = await pair.callTool('elevenlabs_place_call', { operation_id: submit.id, body });
    expect(result.isError, result.text).not.toBe(true);
    expect(received).toEqual(original);
    expect(body).toEqual(original);
    expect(result.json).toMatchObject({ follow_up_operations: ['get_batch_call'], next_step: expect.stringContaining('get_batch_call (path_params.batch_id)') });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly 10,000 structured recipients and refuses 10,001 without dispatch', async () => {
    const body = { call_name: 'Acme batch', agent_id: 'agent_guide', recipients: Array.from({ length: 10000 }, () => ({ phone_number: '+12025550101' })) };
    await expect(validateRequest('place_call', { operation_id: submit.id, body }, createRedactor([]))).resolves.toMatchObject({ body });
    body.recipients.push({ phone_number: '+12025550102' });
    await expect(validateRequest('place_call', { operation_id: submit.id, body }, createRedactor([]))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it.each([
    { body: { call_name: 'Acme', agent_id: 'agent_guide', recipients: 'phone_number\n+12025550101' } },
    { body: { ...submit.body!, target_concurrency_limit: 0 } },
    { body: submit.body, files: [{ field: 'file', file_path: '/never/read.csv' }] },
  ])('refuses CSV ingestion, invalid concurrency and local file operands before I/O: %j', async args => {
    const key = vi.spyOn(auth, 'getApiKey');
    const file = vi.spyOn(fileInput, 'readSandboxedFile');
    const dispatch = vi.spyOn(globalThis, 'fetch');
    const result = await pair.callTool('elevenlabs_place_call', { operation_id: submit.id, ...args });
    expect(result.isError).toBe(true);
    expect(key).not.toHaveBeenCalled(); expect(file).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps literal document tokens and manual filters without projecting or fetching a second page', async () => {
    const wire = cases.find(wire => wire.id === 'get_workspace_batch_calls')!;
    const dispatch = vi.fn(() => HttpResponse.json(wire.response));
    mswServer.use(http.get('https://api.elevenlabs.io/*', dispatch));
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id: wire.id, ...wire.args });
    expect(result.isError, result.text).not.toBe(true);
    expect(JSON.parse(unwrapUntrusted(String((result.json as { data: string }).data)))).toEqual(wire.response);
    expect(result.json).not.toHaveProperty('has_more'); expect(result.json).not.toHaveProperty('next');
    expect((await getOperation(wire.id)).pagination).toBeNull();
    expect(await discoverOperations({ operation_id: wire.id })).toHaveProperty('instructions', expect.stringContaining('pass data.next_doc as query_params.last_doc'));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('distinguishes stopping live work from deleting records and retaining conversations', async () => {
    expect(await getOperation('cancel_batch_call')).toMatchObject({ profile: 'change', effects: { destructiveHint: true }, follow_ups: ['get_batch_call'] });
    expect(await getOperation('delete_batch_call')).toMatchObject({ profile: 'delete', responses: [{ status: 204, media_type: null }], follow_ups: [] });
    expect(await discoverOperations({ operation_id: 'delete_batch_call' })).toHaveProperty('instructions', expect.stringContaining('conversations remain in history'));
  });

  it('exports exact CSV bytes to a contained .csv artifact, ignoring provider filenames', async () => {
    const bytes = Buffer.from([239, 187, 191, 97, 44, 98, 13, 10, 0, 128, 255]);
    const dispatch = vi.fn(() => new HttpResponse(bytes, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="../../untrusted.mp3"' } }));
    mswServer.use(http.get('https://api.elevenlabs.io/*', dispatch));
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'export_batch_call', path_params: { batch_id: 'batch_example' }, query_params: { limit: 2 } });
    expect(result.isError, result.text).not.toBe(true);
    const receipt = result.json as { data: null; artifact: { file_path: string; size_bytes: number; media_type: string } };
    expect(receipt).toMatchObject({ data: null, artifact: { file_path: expect.stringMatching(/elevenlabs_[a-f0-9-]+\.csv$/), size_bytes: bytes.length, media_type: 'text/csv' } });
    expect(dirname(receipt.artifact.file_path)).toBe(workspace);
    expect(readFileSync(receipt.artifact.file_path)).toEqual(bytes);
    expect(readdirSync(workspace)).toHaveLength(1);
    expect(result.text).not.toContain('untrusted.mp3'); expect(result.text).not.toContain('a,b');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await discoverOperations({ operation_id: 'export_batch_call' })).toHaveProperty('instructions', expect.stringContaining('not a continuation cursor'));
  });

  it.each(['audio/mpeg', 'text/plain', 'application/octet-stream'])('refuses undeclared export media %s without creating an artifact', async media => {
    const dispatch = vi.fn(() => new HttpResponse('CSV content must not escape', { headers: { 'Content-Type': media } }));
    mswServer.use(http.get('https://api.elevenlabs.io/*', dispatch));
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'export_batch_call', path_params: { batch_id: 'batch_example' } });
    expect(result.json).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(result.text).not.toContain('CSV content must not escape');
    expect(readdirSync(workspace)).toEqual([]); expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects nonpositive export preview limits before dispatch', async () => {
    await expect(validateRequest('read', { operation_id: 'export_batch_call', path_params: { batch_id: 'batch_example' }, query_params: { limit: 0 } }, createRedactor([]))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
