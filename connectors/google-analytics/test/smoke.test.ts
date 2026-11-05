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

  it('registers exactly 91 tools with ga_ prefix', async () => {
    testClient = await createTestClient({
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: FIXTURE_ADC,
      },
    });

    const toolsResult = await testClient.client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name).sort();

    expect(toolsResult.tools).toHaveLength(91);
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
        'ga_acknowledge_user_data_collection',
        'ga_archive_audience',
        'ga_archive_custom_dimension',
        'ga_archive_custom_metric',
        'ga_create_audience',
        'ga_create_bigquery_link',
        'ga_create_channel_group',
        'ga_create_custom_dimension',
        'ga_create_custom_metric',
        'ga_create_event_create_rule',
        'ga_create_firebase_link',
        'ga_create_google_ads_link',
        'ga_create_key_event',
        'ga_create_measurement_protocol_secret',
        'ga_create_property',
        'ga_create_web_data_stream',
        'ga_delete_bigquery_link',
        'ga_delete_channel_group',
        'ga_delete_data_stream',
        'ga_delete_event_create_rule',
        'ga_delete_firebase_link',
        'ga_delete_google_ads_link',
        'ga_delete_key_event',
        'ga_delete_measurement_protocol_secret',
        'ga_delete_property',
        'ga_get_enhanced_measurement_settings',
        'ga_list_event_create_rules',
        'ga_list_measurement_protocol_secrets',
        'ga_update_audience',
        'ga_update_bigquery_link',
        'ga_update_channel_group',
        'ga_update_custom_dimension',
        'ga_update_custom_metric',
        'ga_update_data_retention_settings',
        'ga_update_data_stream',
        'ga_update_enhanced_measurement_settings',
        'ga_update_event_create_rule',
        'ga_update_google_ads_link',
        'ga_update_key_event',
        'ga_update_property',
        'ga_list_annotations',
        'ga_create_annotation',
        'ga_update_annotation',
        'ga_delete_annotation',
        'ga_get_attribution_settings',
        'ga_update_attribution_settings',
        'ga_list_calculated_metrics',
        'ga_create_calculated_metric',
        'ga_update_calculated_metric',
        'ga_delete_calculated_metric',
        'ga_list_event_edit_rules',
        'ga_create_event_edit_rule',
        'ga_update_event_edit_rule',
        'ga_delete_event_edit_rule',
        'ga_get_google_signals_settings',
        'ga_get_data_sharing_settings',
        'ga_run_funnel_report',
      ].sort(),
    );
  });

  it('marks every tool read-only except the materialisation creates and the config writes', async () => {
    const toolsResult = await testClient.client.listTools();
    const readOnlyAdditions = new Set([
      'ga_get_enhanced_measurement_settings',
      'ga_list_event_create_rules',
      'ga_list_measurement_protocol_secrets',
    ]);
    const creates = new Set([
      'ga_create_audience_export',
      'ga_create_report_task',
      ...toolsResult.tools
        .map((tool) => tool.name)
        .filter((name) => /^ga_(create|update|delete|archive|acknowledge)_/.test(name))
        .filter((name) => !readOnlyAdditions.has(name)),
    ]);
    for (const tool of toolsResult.tools) {
      expect(
        tool.annotations?.readOnlyHint,
        `${tool.name} readOnlyHint`,
      ).toBe(!creates.has(tool.name));
      // Quota-charging creates and every config write are annotated
      // destructive so hosts can gate them behind user approval (invariant #7).
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(
        creates.has(tool.name),
      );
    }
  });
});
