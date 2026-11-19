import { createRedactor } from '../src/api-sensitive.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';
import { setApiKey } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { discoverOperations, getOperation, validateApiCatalog } from '../src/api-catalog.js';
import { createSuccessReceipt, validateRequest } from '../src/api-validation.js';
import { apiCatalog } from '../src/generated/api-catalog.js';
import { unwrapUntrusted } from '../src/untrusted-content.js';
import cases from './fixtures/api-conversation-groups-wire-cases.json' with { type: 'json' };
import { mswServer } from './helpers/setup.js';

let pair: McpTestClient;
beforeEach(async () => { setApiKey('example-connector-credential'); pair = await createInMemoryTestClient({ createServer }); });
afterEach(async () => { await pair.close(); setApiKey(''); vi.restoreAllMocks(); });

describe('conversation groups and group-derived access', () => {
  it('admits all seven operations with distinct admitted read follow-ups', async () => {
    expect(cases).toHaveLength(7);
    for (const wire of cases) {
      const op = await getOperation(wire.id);
      expect(op.profile).toBe(wire.profile);
      for (const id of op.follow_ups) {
        expect(id).not.toBe(wire.id);
        const read = await getOperation(id, 'read');
        await expect(validateRequest('read', { operation_id: id, path_params: Object.fromEntries(read.parameters.path.required.map(name => [name, 'example_id'])) }, createRedactor([]))).resolves.toMatchObject({ operation_id: id });
      }
    }
  });

  it.each([
    ['set_conversation_group_route', 'change', 'changing group-derived access'],
    ['clear_conversation_group_route', 'delete', 'access supplied by that association'],
    ['delete_conversation_group_route', 'delete', 'revokes access granted through that group'],
  ])('%s describes its access effect in discovery and receipts', async (id, profile, phrase) => {
    expect(await discoverOperations({ operation_id: id })).toMatchObject({ profile, effects: { destructiveHint: true }, instructions: expect.stringContaining(phrase) });
    const receipt = await createSuccessReceipt(id, 200, 'application/json', {}, createRedactor([]));
    expect(receipt.effects.destructiveHint).toBe(true);
    expect(receipt.follow_up_operations).not.toContain(id);
    if (id === 'set_conversation_group_route') {
      expect(receipt.next_step).toContain('path_params.conversation_group_id');
      expect((await discoverOperations({ operation_id: id })).instructions).toContain('does not verify conversation membership');
    }
  });

  it('preserves sharing metadata and moves exactly the selected conversation', async () => {
    const wire = cases.find(wire => wire.id === 'get_conversation_group_route')!;
    const requests: { method: string; body: string }[] = [];
    mswServer.use(http.all('https://api.elevenlabs.io/*', async ({ request }) => {
      requests.push({ method: request.method, body: await request.text() });
      return HttpResponse.json(request.method === 'GET' ? wire.response : {});
    }));
    const read = await pair.callTool('elevenlabs_read_resource', { operation_id: wire.id, ...wire.args });
    expect(JSON.parse(unwrapUntrusted(String((read.json as { data: string }).data)))).toMatchObject({ sharing: { people_count: 3, shared_with_everyone: true, everyone_role: 'viewer' }, access_info: { role: 'admin' } });
    const move = await pair.callTool('elevenlabs_change_resource', { operation_id: 'set_conversation_group_route', path_params: { conversation_id: 'conv_example' }, body: { conversation_group_id: 'group_example' } });
    expect(move.isError).not.toBe(true);
    expect(requests).toEqual([{ method: 'GET', body: '' }, { method: 'PUT', body: '{"conversation_group_id":"group_example"}' }]);
  });

  it('continues group cursors and refuses malformed consumed pagination', async () => {
    const wire = cases.find(wire => wire.id === 'list_conversation_groups_route')!;
    const seen: string[] = [];
    mswServer.use(http.get('https://api.elevenlabs.io/*', ({ request }) => {
      seen.push(new URL(request.url).searchParams.get('cursor')!);
      return HttpResponse.json(wire.response);
    }));
    const first = await pair.callTool('elevenlabs_read_resource', { operation_id: wire.id, ...wire.args });
    expect(first.json).toMatchObject({ has_more: true, next: expect.any(String), response_contract: 'matched' });
    const data = JSON.parse(unwrapUntrusted(String((first.json as { data: string }).data)));
    const second = await pair.callTool('elevenlabs_read_resource', { operation_id: wire.id, query_params: { ...wire.args.query_params, cursor: data.next_cursor } });
    expect(second.isError).not.toBe(true);
    expect(seen).toEqual(['page & 2', 'group & 3']);
    for (const response of [{ ...wire.response, has_more: true, next_cursor: null }, { ...wire.response, has_more: 'true' }, { ...wire.response, next_cursor: 2 }]) {
      await expect(createSuccessReceipt(wire.id, 200, 'application/json', response, createRedactor([]))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    catalog.operations.find(op => op.operation_id === wire.id)!.pagination!.response = 'missing_cursor';
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });
});
