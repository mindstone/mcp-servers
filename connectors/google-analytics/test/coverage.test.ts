import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
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

/**
 * Happy-path sweep for the tools not covered by the focused suites
 * (tools.test.ts, audience-exports.test.ts, report-tasks.test.ts,
 * untrusted-content.test.ts).
 */
describe('per-tool happy-path coverage', () => {
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

  async function callOk(name: string, args: Record<string, unknown> = {}) {
    const result = await testClient.client.callTool({ name, arguments: args });
    const parsed = parseToolResult(result);
    expect(parsed.ok, `${name} should succeed`).toBe(true);
    return parsed;
  }

  it('ga_list_properties flattens account summaries and honours filters', async () => {
    await setup();
    const parsed = await callOk('ga_list_properties');
    const properties = parsed.properties as Array<Record<string, unknown>>;
    expect(properties).toHaveLength(1);
    expect(properties[0].property_id).toBe('200');
    expect(properties[0].account_id).toBe('100');
    expect(properties[0].property_name).toBe(
      '<untrusted-content source="ga4-admin">Acme Web</untrusted-content>',
    );

    const filtered = parseToolResult(
      await testClient.client.callTool({
        name: 'ga_list_properties',
        arguments: { account_id: '999' },
      }),
    );
    expect(filtered.properties).toHaveLength(0);
  });

  it('ga_get_property_schema returns counts plus the field lists', async () => {
    await setup();
    const parsed = await callOk('ga_get_property_schema', { property_id: '200' });
    expect(parsed.dimensionCount).toBe(2);
    expect(parsed.metricCount).toBe(2);
  });

  it('ga_list_dimension_categories and ga_list_metric_categories categorise fields', async () => {
    await setup();
    const dims = await callOk('ga_list_dimension_categories', { property_id: '200' });
    expect(dims.categories).toContain('Geography');
    expect(dims.categories).toContain('Time');
    // categoriseField is heuristic and order-sensitive: both mocked metrics
    // land in 'User Demographics' ('totalUsers' matches /user/, 'sessions'
    // matches /age/ inside 'engagement'). Pin the actual behaviour.
    const mets = await callOk('ga_list_metric_categories', { property_id: '200' });
    expect(mets.categories).toContain('User Demographics');
  });

  it('ga_get_dimensions_by_category and ga_get_metrics_by_category filter by category', async () => {
    await setup();
    const dims = await callOk('ga_get_dimensions_by_category', {
      property_id: '200',
      category: 'Geography',
    });
    expect(dims.count).toBe(1);
    expect((dims.dimensions as Array<{ apiName: string }>)[0].apiName).toBe('country');
    const mets = await callOk('ga_get_metrics_by_category', {
      property_id: '200',
      category: 'User Demographics',
    });
    expect((mets.metrics as Array<{ apiName: string }>).map((m) => m.apiName)).toContain(
      'sessions',
    );
  });

  it('ga_get_metadata returns the live schema', async () => {
    await setup();
    const parsed = await callOk('ga_get_metadata', { property_id: '200' });
    expect((parsed.dimensions as unknown[]).length).toBe(2);
    expect((parsed.metrics as unknown[]).length).toBe(2);
  });

  it('ga_run_pivot_report returns pivot headers and rows', async () => {
    await setup();
    const parsed = await callOk('ga_run_pivot_report', {
      property_id: '200',
      dimensions: ['country'],
      metrics: ['sessions'],
      pivots: [{ field_names: ['deviceCategory'] }],
    });
    expect((parsed.pivots as unknown[]).length).toBe(1);
    const rows = parsed.rows as Array<Record<string, string>>;
    expect(
      rows[0]['<untrusted-content source="ga4-report">country</untrusted-content>'],
    ).toBe('<untrusted-content source="ga4-report">United Kingdom</untrusted-content>');
  });

  it('ga_batch_run_reports runs multiple reports in one call', async () => {
    await setup();
    const parsed = await callOk('ga_batch_run_reports', {
      property_id: '200',
      reports: [
        { dimensions: ['country'], metrics: ['totalUsers'], limit: 5 },
        { dimensions: ['country'], metrics: ['sessions'], limit: 5 },
      ],
    });
    const reports = parsed.reports as Array<{ index: number; rows: unknown[] }>;
    expect(reports).toHaveLength(2);
    expect(reports[0].index).toBe(0);
    expect(reports[0].rows).toHaveLength(2);
  });

  it('ga_run_realtime_report returns realtime rows', async () => {
    await setup();
    const parsed = await callOk('ga_run_realtime_report', { property_id: '200' });
    expect(parsed.rowCount).toBe(1);
  });

  it('ga_get_property_quotas_snapshot returns null quota when the API omits it', async () => {
    await setup();
    const parsed = await callOk('ga_get_property_quotas_snapshot', { property_id: '200' });
    expect(parsed.propertyQuota).toBeNull();
  });

  it('ga_list_google_ads_links returns enveloped creator email', async () => {
    await setup();
    const parsed = await callOk('ga_list_google_ads_links', { property_id: '200' });
    const links = parsed.googleAdsLinks as Array<Record<string, unknown>>;
    expect(links).toHaveLength(1);
    expect(links[0].creatorEmailAddress).toBe(
      '<untrusted-content source="ga4-admin">jane@example.com</untrusted-content>',
    );
  });

  it('ga_list_key_events returns enveloped event names', async () => {
    await setup();
    const parsed = await callOk('ga_list_key_events', { property_id: '200' });
    const events = parsed.keyEvents as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe(
      '<untrusted-content source="ga4-admin">purchase</untrusted-content>',
    );
  });

  it('ga_list_data_streams returns the mocked web stream', async () => {
    await setup();
    const parsed = await callOk('ga_list_data_streams', { property_id: '200' });
    const streams = parsed.dataStreams as Array<Record<string, unknown>>;
    expect(streams).toHaveLength(1);
    expect(streams[0].type).toBe('WEB_DATA_STREAM');
    expect(streams[0].displayName).toBe(
      '<untrusted-content source="ga4-admin">Acme Web Stream</untrusted-content>',
    );
  });

  it('ga_get_data_retention_settings returns the retention config', async () => {
    await setup();
    const parsed = await callOk('ga_get_data_retention_settings', { property_id: '200' });
    expect(parsed.eventDataRetention).toBe('FOURTEEN_MONTHS');
    expect(parsed.resetUserDataOnNewActivity).toBe(true);
  });

  it('ga_list_firebase_links returns the mocked link', async () => {
    await setup();
    const parsed = await callOk('ga_list_firebase_links', { property_id: '200' });
    const links = parsed.firebaseLinks as Array<Record<string, unknown>>;
    expect(links).toHaveLength(1);
    expect(links[0].project).toBe('acme-app');
  });

  it('ga_search_change_history_events resolves the parent account and returns events', async () => {
    await setup();
    const parsed = await callOk('ga_search_change_history_events', { property_id: '200' });
    expect(parsed.account).toBe('accounts/100');
    expect(parsed.changeHistoryEvents).toEqual([]);
  });
});
