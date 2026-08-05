/**
 * List membership write tools (add/remove_hubspot_list_members) — happy path,
 * request body shape (bare record-ID array per the v3 Lists API), fan-out cap,
 * and scope-denied error mapping against a mock HubSpot API.
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
} from './fixtures/mcp-test-harness.js';
import { allTools } from '../src/tools/definitions.js';

function createHubSpotConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-list-members-test-'));
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

describe('HubSpot MCP - list membership write tools', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;
  let configDir: string;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();
    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot-list-members',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        {
          method: 'PUT' as const,
          path: '/crm/v3/lists/100/memberships/add',
          handler: () => ({ status: 204, body: null }),
        },
        {
          method: 'PUT' as const,
          path: '/crm/v3/lists/100/memberships/remove',
          handler: () => ({ status: 204, body: null }),
        },
        {
          method: 'PUT' as const,
          path: '/crm/v3/lists/200/memberships/add',
          handler: () => ({
            status: 403,
            body: { status: 'error', message: 'missing crm.lists.write', category: 'MISSING_SCOPES' },
          }),
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

  it('registers both tools flagged destructive with the scope documented', async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('add_hubspot_list_members');
    expect(names).toContain('remove_hubspot_list_members');

    for (const name of ['add_hubspot_list_members', 'remove_hubspot_list_members']) {
      const tool = allTools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(false);
      expect(tool?.annotations?.destructiveHint).toBe(true);
      expect(tool?.description).toContain('crm.lists.write');
      expect(tool?.description).toMatch(/MANUAL and SNAPSHOT/);
    }
  });

  it('add_hubspot_list_members PUTs a bare record-ID array', async () => {
    mockApi.clearLog();
    const result = await client.callToolJson<{ success: boolean; message: string }>(
      'add_hubspot_list_members',
      { listId: '100', recordIds: ['101', '102'] }
    );

    expect(result.success).toBe(true);
    const addReq = mockApi.requestLog.find(
      (r) => r.method === 'PUT' && r.pathname === '/crm/v3/lists/100/memberships/add'
    );
    expect(addReq).toBeDefined();
    expect(addReq!.body).toEqual(['101', '102']);
  });

  it('remove_hubspot_list_members PUTs to the remove endpoint', async () => {
    mockApi.clearLog();
    const result = await client.callToolJson<{ success: boolean }>(
      'remove_hubspot_list_members',
      { listId: '100', recordIds: ['101'] }
    );

    expect(result.success).toBe(true);
    const removeReq = mockApi.requestLog.find(
      (r) => r.method === 'PUT' && r.pathname === '/crm/v3/lists/100/memberships/remove'
    );
    expect(removeReq).toBeDefined();
    expect(removeReq!.body).toEqual(['101']);
  });

  it('caps recordIds at the batch fan-out limit with INPUT_TOO_LARGE', async () => {
    const raw = await client.callToolRaw('add_hubspot_list_members', {
      listId: '100',
      recordIds: Array.from({ length: 101 }, (_, i) => String(i + 1)),
    });
    expect(raw.isError).toBe(true);
    const text = raw.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
    const payload = JSON.parse(text!.text) as { errorCode: string };
    expect(payload.errorCode).toBe('INPUT_TOO_LARGE');
  });

  it('rejects an empty recordIds array before any API call', async () => {
    mockApi.clearLog();
    for (const tool of ['add_hubspot_list_members', 'remove_hubspot_list_members']) {
      const raw = await client.callToolRaw(tool, { listId: '100', recordIds: [] });
      expect(raw.isError).toBe(true);
      const text = raw.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
      expect(text!.text).toContain('recordIds');
    }
    // An empty membership write must be a no-op the model is TOLD about —
    // no request may leave the connector.
    expect(mockApi.requestLog.filter((r) => r.pathname.includes('memberships'))).toHaveLength(0);
  });

  it('maps a scope-denied 403 to the honest multi-cause error', async () => {
    const raw = await client.callToolRaw('add_hubspot_list_members', {
      listId: '200',
      recordIds: ['101'],
    });
    expect(raw.isError).toBe(true);
    const text = raw.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
    const payload = JSON.parse(text!.text) as { errorCode: string; suggestion: string };
    expect(payload.errorCode).toBe('SCOPE_MISSING');
    expect(payload.suggestion).toBeTruthy();
  });
});
