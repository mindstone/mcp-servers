/**
 * Adversarial regression tests: open-ended request structures (fields,
 * pricing tables, metadata) and recipient emails validate fail-closed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const BASE = 'https://api.pandadoc.com/public/v1';
const ENV = { PANDADOC_API_KEY: 'test-pandadoc-key', MCP_HOST_BRIDGE_STATE: '' };

describe('semantic request structures validate fail-closed', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function expectZodRejection(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    let apiCount = 0;
    mswServer.use(
      http.all(`${BASE}/*`, () => {
        apiCount++;
        return HttpResponse.json({});
      }),
    );
    testClient = await createTestClient({ env: ENV });

    const result = await testClient.callTool(tool, args);
    expect(result.isError).toBe(true);
    expect(apiCount).toBe(0);
  }

  const TEMPLATE_BASE = {
    template_uuid: 'tmpl-1',
    recipients: [{ email: 'jane@example.com', role: 'Client' }],
  };

  it('rejects a fields entry that is not a { value } object', async () => {
    await expectZodRejection('create_document_from_template', {
      ...TEMPLATE_BASE,
      fields: { Signature: 'just-a-string' },
    });
  });

  it('rejects a fields entry with unknown extra keys (strict object)', async () => {
    await expectZodRejection('create_document_from_template', {
      ...TEMPLATE_BASE,
      fields: { Signature: { value: 'x', on_conflict: 'replace' } },
    });
  });

  it('rejects nested structures inside metadata', async () => {
    await expectZodRejection('create_document_from_template', {
      ...TEMPLATE_BASE,
      metadata: { opportunity: { id: '123' } },
    });
  });

  it('rejects a pricing adjustment with an unknown type', async () => {
    await expectZodRejection('create_document_from_template', {
      ...TEMPLATE_BASE,
      pricing_tables: [
        { name: 'Pricing Table 1', options: { Discount: { type: 'bogus', value: 10 } } },
      ],
    });
  });

  it('rejects a non-ISO pricing currency', async () => {
    await expectZodRejection('create_document_from_template', {
      ...TEMPLATE_BASE,
      pricing_tables: [{ name: 'Pricing Table 1', options: { currency: 'usd' } }],
    });
  });

  it('rejects a nested object as a pricing row value', async () => {
    await expectZodRejection('create_document_from_template', {
      ...TEMPLATE_BASE,
      pricing_tables: [
        {
          name: 'Pricing Table 1',
          sections: [
            { title: 'S', rows: [{ data: { Name: { nested: 'structure' } } }] },
          ],
        },
      ],
    });
  });

  it('rejects an invalid recipient email on every creation tool', async () => {
    await expectZodRejection('create_document_from_template', {
      template_uuid: 'tmpl-1',
      recipients: [{ email: 'not-an-email', role: 'Client' }],
    });
    await expectZodRejection('upload_document', {
      file_path: '/tmp/whatever.pdf',
      recipients: [{ email: 'not-an-email' }],
    });
    await expectZodRejection('create_document_from_url', {
      url: 'https://files.example.com/x.pdf',
      name: 'X',
      recipients: [{ email: 'not-an-email' }],
    });
  });

  it('accepts a well-formed fields/pricing/metadata payload and forwards it', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(`${BASE}/documents`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 'doc-1',
          name: 'Proposal',
          status: 'document.uploaded',
          date_created: '2026-03-01T10:00:00Z',
          date_modified: '2026-03-01T10:00:00Z',
          expiration_date: null,
          version: null,
          uuid: 'doc-1',
          links: [],
          info_message: '',
        });
      }),
    );
    testClient = await createTestClient({ env: ENV });

    const payload = {
      ...TEMPLATE_BASE,
      fields: { Signature: { value: 'Jane Roe' }, 'Date Signed': { value: '2026-03-01' } },
      metadata: { opportunity_id: '006XX000004TmEQ', priority: 2 },
      pricing_tables: [
        {
          name: 'Pricing Table 1',
          data_merge: true,
          options: {
            currency: 'EUR',
            Tax: { name: 'Tax', type: 'percent', value: 19 },
            Discount: { type: 'absolute', name: 'Launch Discount', value: 50 },
          },
          sections: [
            {
              title: 'Services',
              default: true,
              rows: [
                {
                  options: { qty_editable: true, multichoice_selected: false },
                  data: {
                    Name: 'Widget',
                    Price: 10,
                    QTY: 3,
                    SKU: 'widget-1',
                    Tax: { type: 'percent', value: 0 },
                  },
                  custom_fields: { Fluffiness: '5 / 5' },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = await testClient.callTool('create_document_from_template', payload);
    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(capturedBody).not.toBeNull();
    const body = capturedBody as Record<string, unknown>;
    expect(body.fields).toEqual(payload.fields);
    expect(body.metadata).toEqual(payload.metadata);
    expect(body.pricing_tables).toEqual(payload.pricing_tables);
  });
});
