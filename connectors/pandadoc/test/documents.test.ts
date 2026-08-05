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

  it('create_document_from_template passes pricing_tables through to the API', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post('https://api.pandadoc.com/public/v1/documents', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 'doc-tmpl-2',
          name: 'Priced Proposal',
          status: 'document.uploaded',
          date_created: '2026-03-10T12:00:00Z',
          date_modified: '2026-03-10T12:00:00Z',
          expiration_date: null,
          version: null,
          uuid: 'doc-tmpl-2',
          links: [],
          info_message: 'Poll until document.draft',
        });
      }),
    );
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const pricingTables = [
      {
        name: 'Pricing Table 1',
        data_merge: true,
        options: { currency: 'USD' },
        sections: [
          {
            title: 'Services',
            default: true,
            rows: [
              {
                data: { Name: 'Consulting', Price: 200, QTY: 10, SKU: 'consult-1' },
                custom_fields: { Notes: 'On-site' },
              },
            ],
          },
        ],
      },
    ];

    const result = await testClient.callTool('create_document_from_template', {
      template_uuid: 'tmpl-1',
      recipients: [{ email: 'client@co.com', role: 'Client' }],
      pricing_tables: pricingTables,
    });
    const json = result.json as { ok: boolean; document: { id: string } };
    expect(json.ok).toBe(true);
    expect(capturedBody).toMatchObject({
      template_uuid: 'tmpl-1',
      pricing_tables: pricingTables,
    });
  });

  it('create_document_from_template rejects a pricing table without name via Zod', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('create_document_from_template', {
      template_uuid: 'tmpl-1',
      recipients: [{ email: 'client@co.com', role: 'Client' }],
      pricing_tables: [{ sections: [] }],
    });
    expect(result.isError).toBe(true);
  });

  // ── create_document_from_url ────────────────────────────────────────

  it('create_document_from_url posts url and metadata to the API', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post('https://api.pandadoc.com/public/v1/documents', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 'doc-url-1',
          name: 'Hosted Proposal',
          status: 'document.uploaded',
          date_created: '2026-03-10T12:00:00Z',
          date_modified: '2026-03-10T12:00:00Z',
          expiration_date: null,
          version: null,
          uuid: 'doc-url-1',
          links: [],
          info_message: 'Poll until document.draft',
        });
      }),
    );
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('create_document_from_url', {
      url: 'https://files.example.com/proposal.pdf',
      name: 'Hosted Proposal',
      recipients: [{ email: 'jane@client.com', role: 'Client' }],
      tags: ['sales'],
      folder_uuid: 'folder-1',
    });
    const json = result.json as { ok: boolean; document: { id: string; status: string } };
    expect(json.ok).toBe(true);
    expect(json.document.id).toBe('doc-url-1');
    expect(capturedBody).toEqual({
      url: 'https://files.example.com/proposal.pdf',
      name: 'Hosted Proposal',
      recipients: [{ email: 'jane@client.com', role: 'Client' }],
      tags: ['sales'],
      folder_uuid: 'folder-1',
    });
  });

  it('create_document_from_url rejects a non-HTTPS URL via Zod (no API call)', async () => {
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

    const result = await testClient.callTool('create_document_from_url', {
      url: 'http://files.example.com/proposal.pdf',
      name: 'Hosted Proposal',
    });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('create_document_from_url surfaces API errors', async () => {
    mswServer.use(
      http.post('https://api.pandadoc.com/public/v1/documents', () =>
        HttpResponse.json({ type: 'bad_request', detail: 'URL not reachable' }, { status: 400 }),
      ),
    );
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('create_document_from_url', {
      url: 'https://files.example.com/missing.pdf',
      name: 'Hosted Proposal',
    });
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('API_ERROR');
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

  // ── create_document_session ───────────────────────────────────────

  it('create_document_session returns a signing link for a sent document', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('create_document_session', {
      document_id: 'doc-1',
      recipient: 'jane@client.com',
      lifetime: 900,
    });
    const json = result.json as {
      ok: boolean;
      session: { id: string; expires_at: string; url: string };
    };
    expect(json.ok).toBe(true);
    expect(json.session.id).toBe('nPh2PDhFdDqAES9k64h9qX');
    expect(json.session.url).toBe('https://app.pandadoc.com/s/nPh2PDhFdDqAES9k64h9qX');
    expect(json.session.expires_at).toBeTruthy();
  });

  it('create_document_session sends recipient and lifetime to the API', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post('https://api.pandadoc.com/public/v1/documents/:id/session', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { id: 'sess-1', expires_at: '2026-03-10T13:00:00.000000Z' },
          { status: 201 },
        );
      }),
    );
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    await testClient.callTool('create_document_session', {
      document_id: 'doc-1',
      recipient: 'jane@client.com',
      lifetime: 600,
    });
    expect(capturedBody).toEqual({ recipient: 'jane@client.com', lifetime: 600 });
  });

  it('create_document_session rejects a non-email recipient via Zod (no API call)', async () => {
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

    const result = await testClient.callTool('create_document_session', {
      document_id: 'doc-1',
      recipient: 'not-an-email',
    });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('create_document_session on unknown document returns error', async () => {
    mswServer.use(...createPandaDocHandlers());
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('create_document_session', {
      document_id: 'invalid-id',
      recipient: 'jane@client.com',
    });
    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(false);
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
