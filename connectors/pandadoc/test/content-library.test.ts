import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createPandaDocHandlers } from './helpers/pandadoc-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('PandaDoc content library tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  // ── list_content_library_items ────────────────────────────────────

  it('list_content_library_items returns items with raw ids and enveloped names', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_content_library_items', {});
    const json = result.json as {
      ok: boolean;
      items: Array<{ id: string; name: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.items).toHaveLength(2);
    expect(json.items[0].id).toBe('cli-1');
    expect(json.items[0].name).toBe(
      '<untrusted-content source="pandadoc:list_content_library_items:name">Standard Pricing Table</untrusted-content>',
    );
  });

  it('list_content_library_items with search query filters results', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_content_library_items', { q: 'Clause' });
    const json = result.json as { ok: boolean; items: Array<{ id: string }> };
    expect(json.ok).toBe(true);
    expect(json.items).toHaveLength(1);
    expect(json.items[0].id).toBe('cli-2');
  });

  it('list_content_library_items rejects empty filter values via Zod (no API call)', async () => {
    let requestCount = 0;
    const { http, HttpResponse } = await import('msw');
    mswServer.use(
      http.get('https://api.pandadoc.com/public/v1/*', () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    // The PandaDoc API 400s on empty filter values, so the schema refuses them up front.
    const result = await testClient.callTool('list_content_library_items', { q: '' });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  // ── get_content_library_item_details ──────────────────────────────

  it('get_content_library_item_details returns enveloped workspace-authored fields', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_content_library_item_details', {
      content_library_item_id: 'cli-1',
    });
    const json = result.json as {
      ok: boolean;
      item: {
        id: string;
        name: string;
        created_by: { id: string; email: string };
        metadata: { department: string };
        tokens: Array<{ name: string }>;
        tags: string[];
      };
    };
    expect(json.ok).toBe(true);
    expect(json.item.id).toBe('cli-1');
    expect(json.item.name).toBe(
      '<untrusted-content source="pandadoc:get_content_library_item_details:name">Standard Pricing Table</untrusted-content>',
    );
    expect(json.item.created_by.id).toBe('user-1');
    expect(json.item.created_by.email).toBe(
      '<untrusted-content source="pandadoc:get_content_library_item_details:created_by">admin@co.com</untrusted-content>',
    );
    expect(json.item.metadata.department).toBe(
      '<untrusted-content source="pandadoc:get_content_library_item_details:metadata">sales</untrusted-content>',
    );
    expect(json.item.tokens[0].name).toBe(
      '<untrusted-content source="pandadoc:get_content_library_item_details:tokens">Client.CompanyName</untrusted-content>',
    );
    expect(json.item.tags[0]).toBe(
      '<untrusted-content source="pandadoc:get_content_library_item_details:tags">approved</untrusted-content>',
    );
  });

  it('get_content_library_item_details with unknown id returns error', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_content_library_item_details', {
      content_library_item_id: 'invalid-id',
    });
    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(false);
  });
});
