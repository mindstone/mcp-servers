import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createPandaDocHandlers, createPandaDocUnauthorizedHandlers, createPandaDocTimeoutHandlers } from './helpers/pandadoc-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('PandaDoc document tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  // ── list_documents ──────────────────────────────────────────────

  it('list_documents returns all documents', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_documents', {});
    const json = result.json as { ok: boolean; documents: Array<{ id: string }> };
    expect(json.ok).toBe(true);
    expect(json.documents).toHaveLength(2);
    expect(json.documents[0].id).toBe('doc-1');
  });

  it('list_documents with search query filters results', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_documents', { q: 'NDA' });
    const json = result.json as { ok: boolean; documents: Array<{ id: string; name: string }> };
    expect(json.ok).toBe(true);
    expect(json.documents).toHaveLength(1);
    expect(json.documents[0].name).toBe(
      '<untrusted-content source="pandadoc:list_documents:name">NDA Agreement</untrusted-content>',
    );
  });

  // ── get_document_status ─────────────────────────────────────────

  it('get_document_status returns document status', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_document_status', { document_id: 'doc-1' });
    const json = result.json as { ok: boolean; document: { id: string; status: string } };
    expect(json.ok).toBe(true);
    expect(json.document.id).toBe('doc-1');
    expect(json.document.status).toBe('document.draft');
  });

  it('get_document_status with invalid ID returns error', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_document_status', { document_id: 'invalid-id' });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
  });

  // ── get_document_details ────────────────────────────────────────

  it('get_document_details returns full document data', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_document_details', { document_id: 'doc-1' });
    const json = result.json as {
      ok: boolean;
      document: {
        id: string;
        name: string;
        recipients: Array<{ email: string }>;
        fields: Array<{ type: string }>;
        tags: string[];
        grand_total: { amount: string };
      };
    };
    expect(json.ok).toBe(true);
    expect(json.document.id).toBe('doc-1');
    expect(json.document.recipients).toHaveLength(1);
    expect(json.document.recipients[0].email).toBe(
      '<untrusted-content source="pandadoc:get_document_details:recipients">jane@client.com</untrusted-content>',
    );
    expect(json.document.fields).toHaveLength(1);
    expect(json.document.tags).toContain(
      '<untrusted-content source="pandadoc:get_document_details:tags">sales</untrusted-content>',
    );
    expect(json.document.grand_total.amount).toBe(
      '<untrusted-content source="pandadoc:get_document_details:grand_total">5000</untrusted-content>',
    );
  });

  it('get_document_details with invalid ID returns error', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('get_document_details', { document_id: 'invalid-id' });
    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(false);
  });

  // ── create_document_from_template ───────────────────────────────

  it('create_document_from_template creates a document', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('create_document_from_template', {
      template_uuid: 'tmpl-1',
      name: 'Q1 Proposal',
      recipients: [{ email: 'client@co.com', role: 'Client' }],
    });
    const json = result.json as { ok: boolean; document: { id: string; status: string }; info: string };
    expect(json.ok).toBe(true);
    expect(json.document.id).toBe('doc-tmpl-1');
    expect(json.document.status).toBe('document.uploaded');
    expect(json.info).toBeTruthy();
  });

  it('create_document_from_template without recipients rejects via Zod', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('create_document_from_template', {
      template_uuid: 'tmpl-1',
    });
    // Zod validation should reject missing recipients
    expect(result.isError).toBe(true);
  });

  // ── send_document ───────────────────────────────────────────────

  it('send_document sends a document', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('send_document', {
      document_id: 'doc-1',
      message: 'Please sign',
      subject: 'Contract',
    });
    const json = result.json as {
      ok: boolean;
      document: { id: string; status: string; recipients: Array<{ email: string }> };
      message: string;
    };
    expect(json.ok).toBe(true);
    expect(json.document.status).toBe('document.sent');
    expect(json.message).toContain('sent');
  });

  it('send_document on non-draft document returns 409 error', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('send_document', { document_id: 'doc-not-ready' });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
  });

  it('send_document validates document_id via Zod (requestCount=0)', async () => {
    let requestCount = 0;
    mswServer.use(
      http.post('https://api.pandadoc.com/public/v1/*', () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('send_document', {});
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  // ── download_document ───────────────────────────────────────────

  it('download_document returns file path for valid document', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('download_document', { document_id: 'doc-1' });
    const json = result.json as { ok: boolean; file_path: string; file_size: string };
    expect(json.ok).toBe(true);
    expect(json.file_path).toContain('pandadoc_doc-1');
    expect(json.file_path).toContain('.pdf');
    expect(json.file_size).toBeTruthy();
  });

  it('download_document on non-ready document returns error', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('download_document', { document_id: 'doc-not-ready' });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
  });

  // ── Auth verification: API-Key header format ────────────────────

  it('API-Key auth header format is used (not Bearer)', async () => {
    let capturedAuthHeader: string | null = null;
    const { http, HttpResponse } = await import('msw');

    mswServer.use(
      http.get('https://api.pandadoc.com/public/v1/documents', ({ request }) => {
        capturedAuthHeader = request.headers.get('Authorization');
        return HttpResponse.json({ results: [] });
      }),
    );

    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'my-secret-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    await testClient.callTool('list_documents', {});
    expect(capturedAuthHeader).toBe('API-Key my-secret-key');
    expect(capturedAuthHeader).not.toMatch(/^Bearer /);
  });

  // ── Auth failure: credentials not leaked ────────────────────────

  it('invalid credentials fail cleanly without leaking secrets', async () => {
    mswServer.use(...createPandaDocUnauthorizedHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'super-secret-key-12345', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_documents', {});
    const json = result.json as { ok: boolean; error: string; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('AUTH_FAILED');
    // Ensure the API key is not in the error output
    const resultText = JSON.stringify(json);
    expect(resultText).not.toContain('super-secret-key-12345');
  });

  // ── Timeout handling ────────────────────────────────────────────

  it('network timeout returns actionable MCP error', async () => {
    // Use a handler that delays beyond the AbortSignal.timeout (30s)
    const { http, HttpResponse } = await import('msw');
    mswServer.use(
      http.get('https://api.pandadoc.com/public/v1/documents', async () => {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('list_documents', {});
    const json = result.json as { ok: boolean; error: string; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('TIMEOUT');
    expect(json.error).toContain('timed out');
    // No secrets in output
    const resultText = JSON.stringify(json);
    expect(resultText).not.toContain('test-pandadoc-key');
  }, 45_000);
});
