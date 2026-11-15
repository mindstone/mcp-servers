import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setApiKey } from '../src/auth.js';
import { createServer } from '../src/server.js';
import * as fileInput from '../src/tools/file-input.js';
import { discoverOperations, loadApiCatalog, validateApiCatalog } from '../src/api-catalog.js';
import { createSuccessReceipt, validateRequest } from '../src/api-validation.js';
import { apiCatalog } from '../src/generated/api-catalog.js';
import conversationCases from './fixtures/api-conversations-wire-cases.json' with { type: 'json' };
import { mswServer } from './helpers/setup.js';

let pair: McpTestClient;
let workspace: string;
let requests: number;
const key = 'synthetic-binary-key';
const count = () => requests++;
beforeEach(async () => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'api-conversations-')));
  vi.stubEnv('MCP_WORKSPACE_PATH', workspace);
  setApiKey(key);
  requests = 0;
  mswServer.events.on('request:start', count);
  pair = await createInMemoryTestClient({ createServer });
});
afterEach(async () => {
  await pair.close();
  mswServer.events.removeListener('request:start', count);
  setApiKey('');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
});

describe('conversation and ticket contracts', () => {
  it('admits 26 reviewed contracts and leaves unsupported mixed-media upload planned', async () => {
    expect(conversationCases).toHaveLength(26);
    const catalog = await loadApiCatalog();
    for (const wire of conversationCases) {
      const op = catalog.operations.find(op => op.operation_id === wire.id)!;
      expect(op).toMatchObject({ profile: wire.profile, deprecated: false });
      expect(catalog.operations.find(candidate => candidate.operation_id === op.check_before_retry))
        .toMatchObject({ method: 'GET', profile: 'read' });
      for (const id of op.follow_ups) {
        expect(id).not.toBe(op.operation_id);
        const read = catalog.operations.find(candidate => candidate.operation_id === id)!;
        expect(read.profile).toBe('read');
        await expect(validateRequest('read', { operation_id: id, path_params: Object.fromEntries(read.parameters.path.required.map(name => [name, 'example_id'])) }))
          .resolves.toMatchObject({ operation_id: id });
      }
      const description = await discoverOperations({ operation_id: op.operation_id });
      expect(description).toHaveProperty('contract', expect.stringContaining('"deprecated":false'));
      if (wire.profile === 'read') expect(description).toHaveProperty('contract', expect.stringContaining('summary'));
    }
    for (const id of ['get_signed_url_deprecated']) {
      await expect(validateRequest('create', { operation_id: id })).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' });
    }
  });

  it('describes merge retention, upsert priority and stored analysis effects', async () => {
    for (const [operation_id, phrase] of [
      ['merge_agent_conversation_tickets_route', "source tickets are retained with status 'merged'"],
      ['create_agent_conversation_ticket_route', 'existing open ticket'],
      ['run_conversation_analysis', 'consume credits'],
      ['run_conversation_evaluations', 'replacing its result'],
      ['post_conversation_feedback_route', 'replacing existing feedback'],
    ]) expect(await discoverOperations({ operation_id })).toMatchObject({ profile: 'change', effects: { destructiveHint: true }, instructions: expect.stringContaining(phrase) });
    expect(await discoverOperations({ operation_id: 'get_conversation_histories_route' }))
      .toHaveProperty('instructions', expect.stringContaining('search query parameter is deprecated'));
  });

  it('downloads exact binary bytes once without echoing provider filenames or headers', async () => {
    const bytes = new Uint8Array([0, 255, 128, 10, 65]);
    mswServer.use(http.get('https://api.elevenlabs.io/v1/convai/conversations/conv_example/audio', () => new HttpResponse(bytes, {
      headers: { 'Content-Type': 'audio/mpeg; filename=' + key, 'Content-Disposition': `attachment; filename="../../${key}.mp3"`, 'x-provider-note': key },
    })));
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_conversation_audio_route', path_params: { conversation_id: 'conv_example' } });
    expect(result.isError, result.text).not.toBe(true);
    const receipt = result.json as { data: null; content_type: string; artifact: { file_path: string; size_bytes: number; media_type: string } };
    expect(receipt).toMatchObject({ data: null, content_type: 'audio/mpeg', artifact: { size_bytes: bytes.length, media_type: 'audio/mpeg' } });
    expect(dirname(receipt.artifact.file_path)).toBe(workspace);
    expect(readdirSync(workspace)).toHaveLength(1);
    expect(readFileSync(receipt.artifact.file_path)).toEqual(Buffer.from(bytes));
    expect(result.text).not.toContain(key);
    expect(result.text).not.toContain('Content-Disposition');
    expect(requests).toBe(1);
  });

  it.each(['audio/wav', 'image/png', 'application/octet-stream', 'text/plain'])('refuses undeclared binary media %s without writing', async media => {
    mswServer.use(http.get('https://api.elevenlabs.io/*', () => new HttpResponse(key, { headers: { 'Content-Type': media, 'Content-Disposition': key } })));
    const result = await pair.callTool('elevenlabs_read_resource', { operation_id: 'get_conversation_audio_route', path_params: { conversation_id: 'conv_example' } });
    expect(result.json).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    expect(result.text).not.toContain(key);
    expect(readdirSync(workspace)).toEqual([]);
    expect(requests).toBe(1);
  });

  it.each([
    ['elevenlabs_read_resource', 'get_conversation_summary_route', { conversation_id: 'conv_example' }],
    ['elevenlabs_delete_resource', 'delete_agent_conversation_ticket_route', { agentqa_ticket_id: 'ticket_example' }],
    ['elevenlabs_read_resource', 'get_conversation_history_route', { conversation_id: 'conv_example' }],
    ['elevenlabs_delete_resource', 'delete_conversation_route', { conversation_id: 'conv_example' }],
  ])('%s refuses file operands on %s without reads or network', async (tool, operation_id, path_params) => {
    const read = vi.spyOn(fileInput, 'readSandboxedFile');
    const result = await pair.callTool(tool, { operation_id, path_params, files: [{ field: 'file', file_path: '/does-not-exist.pdf' }] });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('UNKNOWN_OPERATION');
    expect(read).not.toHaveBeenCalled();
    expect(requests).toBe(0);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it('rejects unsupported media at the catalog boundary and binary receipts without artifact metadata', async () => {
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    Object.assign(catalog.operations.find(op => op.operation_id === 'get_conversation_audio_route')!.responses[0], { media_type: 'image/png' });
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
    await expect(createSuccessReceipt('get_conversation_audio_route', 200, 'audio/mpeg', 'raw bytes'))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
