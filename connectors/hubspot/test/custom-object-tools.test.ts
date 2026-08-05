/**
 * Custom-object tools (search/get/create_hubspot_object) — generic CRM object
 * type support: native full-text query passthrough, objectType validation at
 * the handler boundary, and error mapping against a mock HubSpot API.
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
import { customObjectTools } from '../src/tools/definitions.js';

function createHubSpotConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-custom-object-test-'));
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

const WIDGET = {
  id: 'widget-1',
  properties: { widget_name: 'Standard Widget', sku: 'W-100' },
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
  archived: false,
};

describe('HubSpot MCP - custom object tools', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;
  let configDir: string;

  beforeAll(async () => {
    configDir = createHubSpotConfigDir();
    const result = await createMcpTestClientWithMockApi({
      name: 'hubspot-custom-objects',
      serverScript: resolveServerScript('hubspot'),
      interceptDomains: ['api.hubapi.com'],
      routes: [
        {
          method: 'POST' as const,
          path: '/crm/v3/objects/p_widgets/search',
          handler: () => ({ body: { results: [WIDGET] } }),
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/properties/p_widgets',
          handler: () => ({
            body: {
              results: [
                { name: 'widget_name', label: 'Widget name', type: 'string', fieldType: 'text' },
                { name: 'sku', label: 'SKU', type: 'string', fieldType: 'text' },
              ],
            },
          }),
        },
        {
          method: 'GET' as const,
          path: '/crm/v3/objects/p_widgets/widget-1',
          handler: () => ({ body: WIDGET }),
        },
        {
          method: 'POST' as const,
          path: '/crm/v3/objects/p_widgets',
          handler: (req: MockRequest) => {
            const body = req.body as { properties: Record<string, string> };
            return {
              body: {
                id: 'widget-2',
                properties: body.properties,
                createdAt: '2026-04-02T00:00:00Z',
                updatedAt: '2026-04-02T00:00:00Z',
                archived: false,
              },
            };
          },
        },
        {
          method: 'POST' as const,
          path: '/crm/v3/objects/p_secret/search',
          handler: () => ({
            status: 403,
            body: { status: 'error', message: 'missing scopes', category: 'MISSING_SCOPES' },
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

  it('registers the three generic object tools', async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ['search_hubspot_object', 'get_hubspot_object', 'create_hubspot_object']) {
      expect(names).toContain(name);
    }

    const find = (name: string) => customObjectTools.find((t) => t.name === name);
    expect(find('search_hubspot_object')?.annotations?.readOnlyHint).toBe(true);
    expect(find('get_hubspot_object')?.annotations?.readOnlyHint).toBe(true);
    expect(find('create_hubspot_object')?.annotations?.readOnlyHint).toBe(false);
    // Every tool documents the custom-object scope requirement.
    for (const tool of customObjectTools) {
      expect(tool.description).toMatch(/crm\.objects\.custom\.(read|write)/);
    }
  });

  it('search_hubspot_object forwards the text query as HubSpot native full-text search', async () => {
    mockApi.clearLog();
    const result = await client.callToolJson<{
      results: Array<{ id: string; properties: Record<string, string> }>;
    }>('search_hubspot_object', { objectType: 'p_widgets', query: 'Standard' });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('widget-1');
    // Custom object property values are external text and arrive enveloped.
    expect(result.results[0].properties.widget_name).toBe(
      '<untrusted-content source="hubspot:crm/p_widgets">Standard Widget</untrusted-content>'
    );

    const searchReq = mockApi.requestLog.find(
      (r) => r.method === 'POST' && r.pathname === '/crm/v3/objects/p_widgets/search'
    );
    expect(searchReq).toBeDefined();
    const body = searchReq!.body as { query?: string; filterGroups?: unknown[] };
    expect(body.query).toBe('Standard');
    expect(body.filterGroups).toBeUndefined();
  });

  it('get_hubspot_object returns a single custom object record', async () => {
    const result = await client.callToolJson<{
      id: string;
      properties: Record<string, string>;
    }>('get_hubspot_object', { objectType: 'p_widgets', objectId: 'widget-1' });

    expect(result.id).toBe('widget-1');
    expect(result.properties.sku).toContain('W-100');
  });

  it('create_hubspot_object posts the properties to the custom object type', async () => {
    mockApi.clearLog();
    const result = await client.callToolJson<{ id: string }>('create_hubspot_object', {
      objectType: 'p_widgets',
      properties: { widget_name: 'Deluxe Widget', sku: 'W-200' },
    });

    expect(result.id).toBe('widget-2');
    const createReq = mockApi.requestLog.find(
      (r) => r.method === 'POST' && r.pathname === '/crm/v3/objects/p_widgets'
    );
    expect(createReq).toBeDefined();
    const body = createReq!.body as { properties: Record<string, string> };
    expect(body.properties).toEqual({ widget_name: 'Deluxe Widget', sku: 'W-200' });
  });

  it('rejects an objectType with path characters before any API call', async () => {
    mockApi.clearLog();
    const raw = await client.callToolRaw('search_hubspot_object', {
      objectType: 'contacts/search',
      query: 'x',
    });
    expect(raw.isError).toBe(true);
    const text = raw.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
    expect(text!.text).toContain('objectType');

    // No request may leave the connector for an invalid object type.
    expect(
      mockApi.requestLog.filter((r) => r.pathname.includes('contacts/search'))
    ).toHaveLength(0);
  });

  it('maps a custom-object 403 to the honest capability-denied error', async () => {
    const raw = await client.callToolRaw('search_hubspot_object', {
      objectType: 'p_secret',
      query: 'x',
    });
    expect(raw.isError).toBe(true);
    const text = raw.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
    const payload = JSON.parse(text!.text) as { errorCode: string; suggestion: string };
    expect(payload.errorCode).toBe('PERMISSION_DENIED');
    expect(payload.suggestion).toBeTruthy();
  });
});
