import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createPandaDocHandlers } from './helpers/pandadoc-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('PandaDoc discovery tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  // ── list_document_folders ─────────────────────────────────────────

  it('list_document_folders returns folders with raw uuids and enveloped names', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_document_folders', {});
    const json = result.json as {
      ok: boolean;
      folders: Array<{ uuid: string; name: string; has_items: boolean }>;
    };
    expect(json.ok).toBe(true);
    expect(json.folders).toHaveLength(2);
    expect(json.folders[0].uuid).toBe('folder-1');
    expect(json.folders[0].name).toBe(
      '<untrusted-content source="pandadoc:list_document_folders:name">Client Contracts</untrusted-content>',
    );
  });

  it('list_document_folders passes parent_uuid to the API', async () => {
    let capturedParent: string | null = null;
    mswServer.use(
      http.get('https://api.pandadoc.com/public/v1/documents/folders', ({ request }) => {
        capturedParent = new URL(request.url).searchParams.get('parent_uuid');
        return HttpResponse.json({ results: [] });
      }),
    );
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_document_folders', { parent_uuid: 'folder-1' });
    const json = result.json as { ok: boolean; folders: unknown[] };
    expect(json.ok).toBe(true);
    expect(capturedParent).toBe('folder-1');
  });

  it('list_document_folders without API key returns guidance, no API call', async () => {
    let requestCount = 0;
    mswServer.use(
      http.get('https://api.pandadoc.com/public/v1/*', () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_document_folders', {});
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
    expect(requestCount).toBe(0);
  });

  // ── list_contacts ─────────────────────────────────────────────────

  it('list_contacts returns contacts with raw ids and enveloped text fields', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_contacts', {});
    const json = result.json as {
      ok: boolean;
      contacts: Array<{ id: string; email: string; company: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.contacts).toHaveLength(2);
    expect(json.contacts[0].id).toBe('contact-1');
    expect(json.contacts[0].email).toBe(
      '<untrusted-content source="pandadoc:list_contacts">jane@client.com</untrusted-content>',
    );
    expect(json.contacts[0].company).toBe(
      '<untrusted-content source="pandadoc:list_contacts">Acme Corp</untrusted-content>',
    );
  });

  it('list_contacts with email filter narrows results', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_contacts', { email: 'john@example.com' });
    const json = result.json as { ok: boolean; contacts: Array<{ id: string }> };
    expect(json.ok).toBe(true);
    expect(json.contacts).toHaveLength(1);
    expect(json.contacts[0].id).toBe('contact-2');
  });

  it('list_contacts surfaces API errors', async () => {
    mswServer.use(
      http.get('https://api.pandadoc.com/public/v1/contacts', () =>
        HttpResponse.json({ type: 'unauthorized' }, { status: 401 }),
      ),
    );
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_contacts', {});
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('AUTH_FAILED');
  });
});
