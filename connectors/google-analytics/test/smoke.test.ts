import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
import './helpers/mock-auth.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const FIXTURE_ADC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-adc.json',
);

describe('smoke — tool registration', () => {
  let testClient: McpTestClient;

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  it('registers exactly 34 tools with ga_ prefix', async () => {
    testClient = await createTestClient({
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: FIXTURE_ADC,
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name).sort();

    expect(toolsResult.tools).toHaveLength(34);
    expect(toolNames).toEqual(
      [
        'ga_batch_run_reports',
        'ga_check_compatibility',
        'ga_create_audience_export',
        'ga_create_report_task',
        'ga_get_audience_export',
        'ga_get_custom_dimensions_and_metrics',
        'ga_get_data_retention_settings',
        'ga_get_dimensions_by_category',
        'ga_get_global_site_tag',
        'ga_get_metadata',
        'ga_get_metrics_by_category',
        'ga_get_property_details',
        'ga_get_property_quotas_snapshot',
        'ga_get_property_schema',
        'ga_get_report_task',
        'ga_list_account_summaries',
        'ga_list_audience_exports',
        'ga_list_audiences',
        'ga_list_bigquery_links',
        'ga_list_channel_groups',
        'ga_list_data_streams',
        'ga_list_dimension_categories',
        'ga_list_firebase_links',
        'ga_list_google_ads_links',
        'ga_list_key_events',
        'ga_list_metric_categories',
        'ga_list_properties',
        'ga_query_audience_export',
        'ga_query_report_task',
        'ga_run_pivot_report',
        'ga_run_realtime_report',
        'ga_run_report',
        'ga_search_change_history_events',
        'ga_search_schema',
      ].sort(),
    );
  });

  it('marks every tool read-only except the server-side materialisation creates', async () => {
    const toolsResult = await testClient.client.listTools();
    const creates = new Set(['ga_create_audience_export', 'ga_create_report_task']);
    for (const tool of toolsResult.tools) {
      expect(
        tool.annotations?.readOnlyHint,
        `${tool.name} readOnlyHint`,
      ).toBe(!creates.has(tool.name));
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(false);
    }
  });
});
