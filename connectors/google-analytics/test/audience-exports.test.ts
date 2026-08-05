import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import './helpers/mock-auth.js';
import { mswServer } from './helpers/setup.js';
import { createGoogleHandlers } from './helpers/google-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const FIXTURE_ADC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-adc.json',
);

interface TextContent {
  type: 'text';
  text: string;
}

function parseToolResult(result: { content: unknown }) {
  const content = result.content as TextContent[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe('audience export tools', () => {
  let testClient: McpTestClient;

  async function setup() {
    mswServer.use(...createGoogleHandlers());
    testClient = await createTestClient({
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: FIXTURE_ADC,
        GA4_PROPERTY_ID: '200',
      },
    });
  }

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('ga_create_audience_export resolves a bare audience ID and returns the new export', async () => {
    await setup();
    const result = await testClient.client.callTool({
      name: 'ga_create_audience_export',
      arguments: { property_id: '200', audience: '500' },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    const audienceExport = parsed.audienceExport as Record<string, unknown>;
    expect(audienceExport.name).toBe('properties/200/audienceExports/700');
    expect(audienceExport.audience).toBe('properties/200/audiences/500');
    expect(audienceExport.state).toBe('CREATING');
    expect(audienceExport.audienceDisplayName).toBe(
      '<untrusted-content source="ga4-audience-export">Purchasers</untrusted-content>',
    );
  });

  it('ga_create_audience_export is annotated as a destructive, non-idempotent materialisation', async () => {
    await setup();
    const toolsResult = await testClient.client.listTools();
    const tool = toolsResult.tools.find((entry) => entry.name === 'ga_create_audience_export');
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    // Quota-charging server-side materialisation must be marked destructive
    // so hosts can gate it behind explicit user approval (invariant #7).
    expect(tool?.annotations?.destructiveHint).toBe(true);
    expect(tool?.annotations?.idempotentHint).toBe(false);
  });

  it('ga_get_audience_export accepts a full resource name', async () => {
    await setup();
    const result = await testClient.client.callTool({
      name: 'ga_get_audience_export',
      arguments: { export_id: 'properties/200/audienceExports/700' },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    const audienceExport = parsed.audienceExport as Record<string, unknown>;
    expect(audienceExport.state).toBe('ACTIVE');
    expect(audienceExport.rowCount).toBe(2);
  });

  it('ga_list_audience_exports returns the mocked exports', async () => {
    await setup();
    const result = await testClient.client.callTool({
      name: 'ga_list_audience_exports',
      arguments: { property_id: '200' },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    const exports = parsed.audienceExports as Array<Record<string, unknown>>;
    expect(exports).toHaveLength(1);
    expect(exports[0].state).toBe('ACTIVE');
  });

  it('ga_list_audience_exports follows nextPageToken across pages', async () => {
    mswServer.use(...createGoogleHandlers());
    mswServer.use(
      http.get(
        new RegExp(
          `^${'https://analyticsdata.googleapis.com/v1beta'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/properties/[^/]+/audienceExports$`,
        ),
        ({ request }) => {
          const pageToken = new URL(request.url).searchParams.get('pageToken');
          if (!pageToken) {
            return HttpResponse.json({
              audienceExports: [
                { name: 'properties/200/audienceExports/700', state: 'ACTIVE' },
              ],
              nextPageToken: 'page-2',
            });
          }
          return HttpResponse.json({
            audienceExports: [
              { name: 'properties/200/audienceExports/701', state: 'CREATING' },
            ],
          });
        },
      ),
    );
    testClient = await createTestClient({
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: FIXTURE_ADC,
        GA4_PROPERTY_ID: '200',
      },
    });
    const result = await testClient.client.callTool({
      name: 'ga_list_audience_exports',
      arguments: { property_id: '200' },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    const exports = parsed.audienceExports as Array<{ name: string }>;
    expect(exports.map((entry) => entry.name)).toEqual([
      'properties/200/audienceExports/700',
      'properties/200/audienceExports/701',
    ]);
  });

  it('ga_query_audience_export maps rows by dimension name with enveloped values', async () => {
    await setup();
    const result = await testClient.client.callTool({
      name: 'ga_query_audience_export',
      arguments: { export_id: '700', limit: 100 },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.rowCount).toBe(2);
    const rows = parsed.rows as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
    // Vendor-echoed dimension names are enveloped before becoming row keys.
    expect(
      rows[0]['<untrusted-content source="ga4-audience-export">userId</untrusted-content>'],
    ).toBe('<untrusted-content source="ga4-audience-export">user-1</untrusted-content>');
    expect(
      rows[1]['<untrusted-content source="ga4-audience-export">deviceId</untrusted-content>'],
    ).toBe('<untrusted-content source="ga4-audience-export">device-2</untrusted-content>');
  });

  it('returns a structured error when export_id is empty', async () => {
    await setup();
    const result = await testClient.client.callTool({
      name: 'ga_get_audience_export',
      arguments: { property_id: '200', export_id: 'audienceExports/' },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('AUDIENCE_EXPORT_ID_REQUIRED');
  });
});
