import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createServiceNowHandlers } from './helpers/servicenow-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const TEST_ENV = {
  SERVICENOW_INSTANCE: 'test-instance',
  SERVICENOW_USERNAME: 'test-user',
  SERVICENOW_PASSWORD: 'test-pass',
  MCP_HOST_BRIDGE_STATE: '',
};

describe('ServiceNow service catalog tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  // ── list_servicenow_catalog_items ─────────────────────────────

  it('list_servicenow_catalog_items returns catalog items', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('list_servicenow_catalog_items', {});
    const json = result.json as {
      ok: boolean;
      catalog_items: Array<{ sys_id: string; name: string }>;
      count: number;
    };
    expect(json.ok).toBe(true);
    expect(json.catalog_items).toHaveLength(2);
    expect(json.catalog_items[0].sys_id).toBe('cat-sys-id-001');
    // Free text is enveloped (invariant #6)
    expect(json.catalog_items[0].name).toBe(
      '<untrusted-content source="servicenow:catalog-item:name">Standard laptop</untrusted-content>',
    );
    expect(json.count).toBe(2);
  });

  it('list_servicenow_catalog_items with keyword filters results', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('list_servicenow_catalog_items', {
      query: 'laptop',
    });
    const json = result.json as {
      ok: boolean;
      catalog_items: Array<{ name: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.catalog_items).toHaveLength(1);
    expect(json.catalog_items[0].name).toContain('laptop');
  });

  // ── get_servicenow_catalog_item ───────────────────────────────

  it('get_servicenow_catalog_item returns the full item', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_catalog_item', {
      sys_id: 'cat-sys-id-001',
    });
    const json = result.json as {
      ok: boolean;
      catalog_item: { sys_id: string; description: string };
    };
    expect(json.ok).toBe(true);
    expect(json.catalog_item.sys_id).toBe('cat-sys-id-001');
    expect(json.catalog_item.description).toContain('14-inch business laptop');
    expect(json.catalog_item.description).toContain('<untrusted-content');
  });

  it('get_servicenow_catalog_item with unknown sys_id returns not found', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_catalog_item', {
      sys_id: 'no-such-item',
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('NOT_FOUND');
  });

  it('get_servicenow_catalog_item rejects empty sys_id via Zod', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({ env: TEST_ENV });

    const result = await testClient.callTool('get_servicenow_catalog_item', {
      sys_id: '',
    });
    expect(result.isError).toBe(true);
  });
});
