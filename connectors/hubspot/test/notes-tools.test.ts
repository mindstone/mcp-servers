/**
 * Notes read/update/delete tools (search/get/update/delete_hubspot_note) —
 * happy path, request shape, and error mapping against a mock HubSpot API.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMcpTestClientWithMockApi,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer,
  type MockRequest,
} from './fixtures/mcp-test-harness.js';
import { noteTools } from '../src/tools/definitions.js';

function createHubSpotConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-notes-test-'));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({ accounts: [{ email: 'test@example.com', hubId: 12345678 }] })
  );
  writeFileSync(
    join(configDir, 'credentials', 'test-example-com.token.json'),
    JSON.stringify({
      access_token: 'fake-access-token-for-testing',
      refresh_token: 'fake-refresh-token',
      expires_at: Date.now() + 86400000 * 365,
      hub_id: 12345678,
      user: 'test@example.com',
    })
  );
  return configDir;
}

const NOTE = {
  id: 'note-1',
  properties: {
    hs_note_body: 'Discussed Q3 rollout with Acme Corp',
    hs_timestamp: '2026-05-19T14:02:11Z',
    hubspot_owner_id: '5001',
  },
  createdAt: '2026-05-19T14:02:11Z',
  updatedAt: '2026-05-19T14:02:11Z',
  archived: false,
};

describe('HubSpot MCP - notes read/update/delete tools', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;
  let configDir: string;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();
    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot-notes',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        {
          method: 'POST' as const,
          path: '/crm/v3/objects/notes/search',
          handler: () => ({ body: { results: [NOTE] } }),
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/properties/notes',
          handler: () => ({
            body: {
              results: [
                { name: 'hs_note_body', label: 'Note body', type: 'string', fieldType: 'textarea' },
                { name: 'hs_timestamp', label: 'Timestamp', type: 'datetime', fieldType: 'date' },
              ],
            },
          }),
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/objects/notes/note-1',
          handler: () => ({ body: NOTE }),
        },
        {
          method: 'PATCH' as const,
          path: '/crm/v3/objects/notes/note-1',
          handler: (req: MockRequest) => {
            const body = req.body as { properties: Record<string, string> };
            return {
              body: {
                ...NOTE,
                properties: { ...NOTE.properties, ...body.properties },
                updatedAt: '2026-05-20T09:00:00Z',
              },
            };
          },
        },
        {
          method: 'DELETE' as const,
          path: '/crm/v3/objects/notes/note-1',
          handler: () => ({ status: 204, body: null }),
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/objects/notes/missing-note',
          handler: () => ({ status: 404, body: { status: 'error', message: 'resource not found', category: 'OBJECT_NOT_FOUND' } }),
        },
      ],
      env: {
        HUBSPOT_CONFIG_DIR: configDir,
        HUBSPOT_CLIENT_ID: 'fake-client-id',
        HUBSPOT_CLIENT_SECRET: 'fake-client-secret',
        HUBSPOT_ACCOUNT_EMAIL: 'test@example.com',
      },
      connectTimeout: 15_000,
    });
    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await mockApi?.close();
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  it('registers all five note tools with the right annotations', async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      'search_hubspot_notes',
      'get_hubspot_note',
      'create_hubspot_note',
      'update_hubspot_note',
      'delete_hubspot_note',
    ]) {
      expect(names).toContain(name);
    }

    const find = (name: string) => noteTools.find((t) => t.name === name);
    expect(find('search_hubspot_notes')?.annotations?.readOnlyHint).toBe(true);
    expect(find('get_hubspot_note')?.annotations?.readOnlyHint).toBe(true);
    expect(find('update_hubspot_note')?.annotations?.readOnlyHint).toBe(false);
    expect(find('delete_hubspot_note')?.annotations?.destructiveHint).toBe(true);
  });

  it('search_hubspot_notes matches query against hs_note_body via CONTAINS_TOKEN', async () => {
    mockApi.clearLog();
    const result = await client.callToolJson<{
      results: Array<{ id: string; properties: Record<string, string> }>;
    }>('search_hubspot_notes', { query: 'Q3 rollout' });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('note-1');
    // Note bodies are attacker-controllable text and arrive enveloped.
    expect(result.results[0].properties.hs_note_body).toBe(
      '<untrusted-content source="hubspot:crm/notes">Discussed Q3 rollout with Acme Corp</untrusted-content>'
    );

    const searchReq = mockApi.requestLog.find(
      (r) => r.method === 'POST' && r.pathname === '/crm/v3/objects/notes/search'
    );
    expect(searchReq).toBeDefined();
    const body = searchReq!.body as {
      filterGroups?: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }>;
    };
    const hasBodyFilter = body.filterGroups?.some((fg) =>
      fg.filters.some(
        (f) => f.propertyName === 'hs_note_body' && f.operator === 'CONTAINS_TOKEN' && f.value === 'Q3 rollout'
      )
    );
    expect(hasBodyFilter).toBe(true);
  });

  it('get_hubspot_note returns a single note', async () => {
    const result = await client.callToolJson<{
      id: string;
      properties: Record<string, string>;
    }>('get_hubspot_note', { noteId: 'note-1' });

    expect(result.id).toBe('note-1');
    expect(result.properties.hs_note_body).toContain('Q3 rollout');
    expect(result.properties.hubspot_owner_id).toBe('5001');
  });

  it('update_hubspot_note patches only the provided properties', async () => {
    mockApi.clearLog();
    const result = await client.callToolJson<{
      id: string;
      properties: Record<string, string>;
    }>('update_hubspot_note', {
      noteId: 'note-1',
      properties: { hs_note_body: 'Updated: Q3 rollout moved to Q4' },
    });

    expect(result.id).toBe('note-1');
    const updateReq = mockApi.requestLog.find(
      (r) => r.method === 'PATCH' && r.pathname === '/crm/v3/objects/notes/note-1'
    );
    expect(updateReq).toBeDefined();
    const body = updateReq!.body as { properties: Record<string, string> };
    expect(body.properties).toEqual({ hs_note_body: 'Updated: Q3 rollout moved to Q4' });
  });

  it('delete_hubspot_note archives the note', async () => {
    mockApi.clearLog();
    const result = await client.callToolJson<{ success: boolean; message: string }>(
      'delete_hubspot_note',
      { noteId: 'note-1' }
    );

    expect(result.success).toBe(true);
    const deleteReq = mockApi.requestLog.find(
      (r) => r.method === 'DELETE' && r.pathname === '/crm/v3/objects/notes/note-1'
    );
    expect(deleteReq).toBeDefined();
  });

  it('get_hubspot_note maps a 404 to a structured NOT_FOUND error', async () => {
    const raw = await client.callToolRaw('get_hubspot_note', { noteId: 'missing-note' });
    expect(raw.isError).toBe(true);
    const text = raw.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
    const payload = JSON.parse(text!.text) as { errorCode: string };
    expect(payload.errorCode).toBe('NOT_FOUND');
  });
});
