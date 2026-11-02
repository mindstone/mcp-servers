import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import './helpers/mock-auth.js';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const FIXTURE_ADC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-adc.json',
);

const ADMIN_HOST = 'https://analyticsadmin.googleapis.com';

interface RecordedCall {
  method: string;
  version: string;
  path: string;
  updateMask: string | null;
  body: unknown;
}

interface TextContent {
  type: 'text';
  text: string;
}

/**
 * Handler results are JSON; schema rejections raised by the SDK before the
 * handler runs are plain text, surfaced here as `{ sdkError }`.
 */
function parseToolResult(result: { content: unknown }) {
  const content = result.content as TextContent[];
  try {
    return JSON.parse(content[0].text) as Record<string, unknown>;
  } catch {
    return { sdkError: content[0].text } as Record<string, unknown>;
  }
}

/** Look up a field in an enveloped blob, whose keys are enveloped too. */
function enveloped(obj: unknown, key: string): unknown {
  return (obj as Record<string, unknown>)[
    `<untrusted-content source="ga4-admin">${key}</untrusted-content>`
  ];
}

/**
 * Catch-all Admin API handler: records every call and echoes back a
 * resource named after the request path, with one user-authored field so
 * envelope behaviour is observable. DELETE returns Google's empty body.
 */
function recordingHandler(calls: RecordedCall[]) {
  return http.all(`${ADMIN_HOST}/*`, async ({ request }) => {
    const url = new URL(request.url);
    const [, version, ...rest] = url.pathname.split('/');
    const resourcePath = rest.join('/');
    const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    calls.push({
      method: request.method,
      version,
      path: resourcePath,
      updateMask: url.searchParams.get('updateMask'),
      body: text ? JSON.parse(text) : undefined,
    });
    if (request.method === 'DELETE') return new HttpResponse(null, { status: 200 });
    const name = resourcePath.replace(/:[A-Za-z]+$/, '');
    return HttpResponse.json({ name, displayName: 'Acme Signups' });
  });
}

let testClient: McpTestClient | undefined;

async function setup(env: Record<string, string> = {}) {
  const calls: RecordedCall[] = [];
  mswServer.use(recordingHandler(calls));
  testClient = await createTestClient({
    env: {
      GOOGLE_APPLICATION_CREDENTIALS: FIXTURE_ADC,
      GA4_PROPERTY_ID: '200',
      GA4_ALLOW_WRITES: 'true',
      ...env,
    },
  });
  return calls;
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await testClient!.client.callTool({ name, arguments: args });
  return { result, parsed: parseToolResult(result) };
}

afterEach(async () => {
  if (testClient) await testClient.close();
  testClient = undefined;
});

interface WriteCase {
  tool: string;
  args: Record<string, unknown>;
  method: string;
  version?: 'v1beta' | 'v1alpha';
  path: string;
  updateMask?: string;
  body?: Record<string, unknown>;
}

const CONFIRM = { confirm: true };

const WRITE_CASES: WriteCase[] = [
  // Definitions
  {
    tool: 'ga_create_custom_dimension',
    args: { property_id: '200', parameter_name: 'plan_tier', display_name: 'Plan tier', scope: 'USER' },
    method: 'POST',
    path: 'properties/200/customDimensions',
    body: { parameterName: 'plan_tier', displayName: 'Plan tier', scope: 'USER' },
  },
  {
    tool: 'ga_update_custom_dimension',
    args: { custom_dimension: '11', display_name: 'Plan' },
    method: 'PATCH',
    path: 'properties/200/customDimensions/11',
    updateMask: 'displayName',
  },
  {
    tool: 'ga_archive_custom_dimension',
    args: { custom_dimension: '11', ...CONFIRM },
    method: 'POST',
    path: 'properties/200/customDimensions/11:archive',
  },
  {
    tool: 'ga_create_custom_metric',
    args: { property_id: '200', parameter_name: 'seats', display_name: 'Seats', measurement_unit: 'STANDARD' },
    method: 'POST',
    path: 'properties/200/customMetrics',
    body: { parameterName: 'seats', scope: 'EVENT', measurementUnit: 'STANDARD' },
  },
  {
    tool: 'ga_update_custom_metric',
    args: { custom_metric: '12', description: 'Seats bought' },
    method: 'PATCH',
    path: 'properties/200/customMetrics/12',
    updateMask: 'description',
  },
  {
    tool: 'ga_archive_custom_metric',
    args: { custom_metric: '12', ...CONFIRM },
    method: 'POST',
    path: 'properties/200/customMetrics/12:archive',
  },
  {
    tool: 'ga_create_key_event',
    args: {
      property_id: '200',
      event_name: 'sign_up',
      counting_method: 'ONCE_PER_EVENT',
      default_value: { numericValue: 10, currencyCode: 'GBP' },
    },
    method: 'POST',
    path: 'properties/200/keyEvents',
    body: { eventName: 'sign_up', defaultValue: { numericValue: 10, currencyCode: 'GBP' } },
  },
  {
    tool: 'ga_update_key_event',
    args: { key_event: '13', counting_method: 'ONCE_PER_SESSION' },
    method: 'PATCH',
    path: 'properties/200/keyEvents/13',
    updateMask: 'countingMethod',
  },
  {
    tool: 'ga_delete_key_event',
    args: { key_event: '13', ...CONFIRM },
    method: 'DELETE',
    path: 'properties/200/keyEvents/13',
  },
  {
    tool: 'ga_create_audience',
    args: {
      property_id: '200',
      display_name: 'Pricing visitors',
      description: 'Viewed pricing',
      membership_duration_days: 30,
      filter_clauses: [{ clauseType: 'INCLUDE', simpleFilter: { scope: 'AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS' } }],
    },
    method: 'POST',
    version: 'v1alpha',
    path: 'properties/200/audiences',
    body: { membershipDurationDays: 30 },
  },
  {
    tool: 'ga_update_audience',
    args: { audience: '14', display_name: 'Pricing', membership_duration_days: 60 },
    method: 'PATCH',
    version: 'v1alpha',
    path: 'properties/200/audiences/14',
    updateMask: 'displayName,membershipDurationDays',
  },
  {
    tool: 'ga_archive_audience',
    args: { audience: '14', ...CONFIRM },
    method: 'POST',
    version: 'v1alpha',
    path: 'properties/200/audiences/14:archive',
  },
  {
    tool: 'ga_create_channel_group',
    args: { property_id: '200', display_name: 'Paid split', grouping_rule: [{ displayName: 'Paid LinkedIn' }] },
    method: 'POST',
    version: 'v1alpha',
    path: 'properties/200/channelGroups',
  },
  {
    tool: 'ga_update_channel_group',
    args: { channel_group: '15', primary: true },
    method: 'PATCH',
    version: 'v1alpha',
    path: 'properties/200/channelGroups/15',
    updateMask: 'primary',
  },
  {
    tool: 'ga_delete_channel_group',
    args: { channel_group: '15', ...CONFIRM },
    method: 'DELETE',
    version: 'v1alpha',
    path: 'properties/200/channelGroups/15',
  },
  {
    tool: 'ga_create_event_create_rule',
    args: {
      data_stream: '300',
      destination_event: 'demo_booked',
      event_conditions: [{ field: 'eventName', comparisonType: 'EQUALS', value: 'page_view' }],
    },
    method: 'POST',
    version: 'v1alpha',
    path: 'properties/200/dataStreams/300/eventCreateRules',
    body: { destinationEvent: 'demo_booked' },
  },
  {
    tool: 'ga_update_event_create_rule',
    args: { data_stream: '300', event_create_rule: '16', source_copy_parameters: true },
    method: 'PATCH',
    version: 'v1alpha',
    path: 'properties/200/dataStreams/300/eventCreateRules/16',
    updateMask: 'sourceCopyParameters',
  },
  {
    tool: 'ga_delete_event_create_rule',
    args: { data_stream: '300', event_create_rule: '16', ...CONFIRM },
    method: 'DELETE',
    version: 'v1alpha',
    path: 'properties/200/dataStreams/300/eventCreateRules/16',
  },
  // Configuration
  {
    tool: 'ga_create_property',
    args: { account_id: 'accounts/100', display_name: 'Acme Web', time_zone: 'Europe/London' },
    method: 'POST',
    path: 'properties',
    body: { parent: 'accounts/100', displayName: 'Acme Web', timeZone: 'Europe/London' },
  },
  {
    tool: 'ga_update_property',
    args: { property_id: '200', currency_code: 'GBP', time_zone: 'Europe/London' },
    method: 'PATCH',
    path: 'properties/200',
    updateMask: 'timeZone,currencyCode',
  },
  {
    tool: 'ga_delete_property',
    args: { property_id: '200', ...CONFIRM },
    method: 'DELETE',
    path: 'properties/200',
  },
  {
    tool: 'ga_acknowledge_user_data_collection',
    args: { property_id: '200', ...CONFIRM },
    method: 'POST',
    path: 'properties/200:acknowledgeUserDataCollection',
  },
  {
    tool: 'ga_create_web_data_stream',
    args: { property_id: '200', display_name: 'Site', default_uri: 'https://www.example.com' },
    method: 'POST',
    path: 'properties/200/dataStreams',
    body: { type: 'WEB_DATA_STREAM', webStreamData: { defaultUri: 'https://www.example.com' } },
  },
  {
    tool: 'ga_update_data_stream',
    args: { data_stream: '300', default_uri: 'https://example.org' },
    method: 'PATCH',
    path: 'properties/200/dataStreams/300',
    updateMask: 'webStreamData.defaultUri',
  },
  {
    tool: 'ga_delete_data_stream',
    args: { data_stream: '300', ...CONFIRM },
    method: 'DELETE',
    path: 'properties/200/dataStreams/300',
  },
  {
    tool: 'ga_update_enhanced_measurement_settings',
    args: { data_stream: '300', scrolls_enabled: false, form_interactions_enabled: true },
    method: 'PATCH',
    version: 'v1alpha',
    path: 'properties/200/dataStreams/300/enhancedMeasurementSettings',
    updateMask: 'scrollsEnabled,formInteractionsEnabled',
  },
  {
    tool: 'ga_create_measurement_protocol_secret',
    args: { data_stream: '300', display_name: 'Server events' },
    method: 'POST',
    path: 'properties/200/dataStreams/300/measurementProtocolSecrets',
  },
  {
    tool: 'ga_delete_measurement_protocol_secret',
    args: { data_stream: '300', secret: '17', ...CONFIRM },
    method: 'DELETE',
    path: 'properties/200/dataStreams/300/measurementProtocolSecrets/17',
  },
  {
    tool: 'ga_create_google_ads_link',
    args: { property_id: '200', customer_id: '1234567890' },
    method: 'POST',
    path: 'properties/200/googleAdsLinks',
    body: { customerId: '1234567890' },
  },
  {
    tool: 'ga_update_google_ads_link',
    args: { google_ads_link: '18', ads_personalization_enabled: false },
    method: 'PATCH',
    path: 'properties/200/googleAdsLinks/18',
    updateMask: 'adsPersonalizationEnabled',
  },
  {
    tool: 'ga_delete_google_ads_link',
    args: { google_ads_link: '18', ...CONFIRM },
    method: 'DELETE',
    path: 'properties/200/googleAdsLinks/18',
  },
  {
    tool: 'ga_create_firebase_link',
    args: { property_id: '200', project: 'projects/acme-app' },
    method: 'POST',
    path: 'properties/200/firebaseLinks',
  },
  {
    tool: 'ga_delete_firebase_link',
    args: { firebase_link: '19', ...CONFIRM },
    method: 'DELETE',
    path: 'properties/200/firebaseLinks/19',
  },
  {
    tool: 'ga_create_bigquery_link',
    args: { property_id: '200', project: 'projects/acme-data', dataset_location: 'EU', daily_export_enabled: true },
    method: 'POST',
    version: 'v1alpha',
    path: 'properties/200/bigQueryLinks',
    body: { project: 'projects/acme-data', datasetLocation: 'EU', dailyExportEnabled: true },
  },
  {
    tool: 'ga_update_bigquery_link',
    args: { bigquery_link: '20', streaming_export_enabled: true },
    method: 'PATCH',
    version: 'v1alpha',
    path: 'properties/200/bigQueryLinks/20',
    updateMask: 'streamingExportEnabled',
  },
  {
    tool: 'ga_delete_bigquery_link',
    args: { bigquery_link: '20', ...CONFIRM },
    method: 'DELETE',
    version: 'v1alpha',
    path: 'properties/200/bigQueryLinks/20',
  },
  {
    tool: 'ga_update_data_retention_settings',
    args: { property_id: '200', event_data_retention: 'FOURTEEN_MONTHS', ...CONFIRM },
    method: 'PATCH',
    path: 'properties/200/dataRetentionSettings',
    updateMask: 'eventDataRetention',
  },
];

describe('write tools — request shape', () => {
  it.each(WRITE_CASES)('$tool sends $method $path', async (testCase) => {
    const calls = await setup();
    const { result, parsed } = await call(testCase.tool, testCase.args);
    expect(result.isError ?? false, JSON.stringify(parsed)).toBe(false);
    expect(parsed.ok).toBe(true);

    expect(calls).toHaveLength(1);
    const [sent] = calls;
    expect(sent.method).toBe(testCase.method);
    expect(sent.version).toBe(testCase.version ?? 'v1beta');
    expect(sent.path).toBe(testCase.path);
    expect(sent.updateMask).toBe(testCase.updateMask ?? null);
    if (testCase.body) expect(sent.body).toMatchObject(testCase.body);
    // The confirmation flag is a tool-level guard and never reaches Google.
    expect(JSON.stringify(sent.body ?? {})).not.toContain('confirm');
  });

  it('covers every write tool the server registers', async () => {
    await setup();
    const { tools } = await testClient!.client.listTools();
    const writeTools = tools.filter((tool) => tool.annotations?.readOnlyHint === false);
    const exportCreates = new Set(['ga_create_audience_export', 'ga_create_report_task']);
    const configWrites = writeTools.map((tool) => tool.name).filter((name) => !exportCreates.has(name));
    expect(configWrites.sort()).toEqual(WRITE_CASES.map((c) => c.tool).sort());
  });
});

describe('write tools — guards', () => {
  it('refuses every write when GA4_ALLOW_WRITES is not set, without calling Google', async () => {
    const calls = await setup({ GA4_ALLOW_WRITES: '' });
    for (const testCase of WRITE_CASES) {
      const { result, parsed } = await call(testCase.tool, testCase.args);
      expect(result.isError, testCase.tool).toBe(true);
      expect(parsed.code, testCase.tool).toBe('WRITES_DISABLED');
    }
    expect(calls).toHaveLength(0);
  });

  it('treats values other than true/1 as disabled', async () => {
    const calls = await setup({ GA4_ALLOW_WRITES: 'yes' });
    const { parsed } = await call('ga_create_key_event', {
      property_id: '200',
      event_name: 'sign_up',
      counting_method: 'ONCE_PER_EVENT',
    });
    expect(parsed.code).toBe('WRITES_DISABLED');
    expect(calls).toHaveLength(0);
  });

  it('rejects removals without confirm: true', async () => {
    const calls = await setup();
    for (const args of [{ key_event: '13' }, { key_event: '13', confirm: false }]) {
      const { result, parsed } = await call('ga_delete_key_event', args);
      expect(result.isError).toBe(true);
      expect(String(parsed.sdkError)).toContain('confirm');
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects an update with no fields to change', async () => {
    const calls = await setup();
    const { parsed } = await call('ga_update_custom_dimension', { custom_dimension: '11' });
    expect(parsed.code).toBe('NOTHING_TO_UPDATE');
    expect(calls).toHaveLength(0);
  });

  it('rejects resource IDs that could reshape the request path', async () => {
    const calls = await setup();
    for (const bad of ['../../accounts/1', '11?updateMask=parameterName', 'properties/200/keyEvents/1/../2']) {
      const { parsed } = await call('ga_update_key_event', { key_event: bad, counting_method: 'ONCE_PER_EVENT' });
      expect(parsed.code, bad).toBe('INVALID_RESOURCE_ID');
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid enum and format arguments before calling Google', async () => {
    const calls = await setup();
    const badCalls: Array<[string, Record<string, unknown>]> = [
      ['ga_create_custom_dimension', { property_id: '200', parameter_name: 'bad name', display_name: 'x', scope: 'EVENT' }],
      ['ga_create_google_ads_link', { property_id: '200', customer_id: '123-456-7890' }],
      ['ga_update_data_retention_settings', { property_id: '200', event_data_retention: 'FOREVER', confirm: true }],
    ];
    for (const [tool, args] of badCalls) {
      const { result, parsed } = await call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(parsed.sdkError, tool).toBeDefined();
    }
    expect(calls).toHaveLength(0);
  });
});

describe('write tools — resource names and output', () => {
  it('accepts a full resource name and uses its property', async () => {
    const calls = await setup();
    await call('ga_update_custom_dimension', {
      custom_dimension: 'properties/999/customDimensions/11',
      display_name: 'Plan',
    });
    expect(calls[0].path).toBe('properties/999/customDimensions/11');
  });

  it('accepts a full stream-child resource name', async () => {
    const calls = await setup();
    await call('ga_delete_event_create_rule', {
      data_stream: 'ignored',
      event_create_rule: 'properties/999/dataStreams/301/eventCreateRules/16',
      confirm: true,
    });
    expect(calls[0].path).toBe('properties/999/dataStreams/301/eventCreateRules/16');
  });

  it('returns the resource name raw and envelopes user-authored fields', async () => {
    await setup();
    const { parsed } = await call('ga_create_key_event', {
      property_id: '200',
      event_name: 'sign_up',
      counting_method: 'ONCE_PER_EVENT',
    });
    expect(parsed.name).toBe('properties/200/keyEvents');
    expect(parsed.action).toBe('keyEvents.create');
    expect(enveloped(parsed.resource, 'displayName')).toBe(
      '<untrusted-content source="ga4-admin">Acme Signups</untrusted-content>',
    );
  });

  it('reports the deleted resource name when Google returns an empty body', async () => {
    await setup();
    const { parsed } = await call('ga_delete_key_event', { key_event: '13', confirm: true });
    expect(parsed).toEqual({ ok: true, action: 'keyEvents.delete', name: 'properties/200/keyEvents/13' });
  });

  it('sends the exact acknowledgement sentence Google requires', async () => {
    const calls = await setup();
    await call('ga_acknowledge_user_data_collection', { property_id: '200', confirm: true });
    expect((calls[0].body as { acknowledgement: string }).acknowledgement).toMatch(
      /^I acknowledge that I have the necessary privacy disclosures and rights from my end users/,
    );
  });
});

describe('write tools — API errors', () => {
  it('surfaces a permission error with the vendor message enveloped', async () => {
    mswServer.use(
      http.post(`${ADMIN_HOST}/v1beta/properties/200/keyEvents`, () =>
        HttpResponse.json(
          { error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } },
          { status: 403 },
        ),
      ),
    );
    testClient = await createTestClient({
      env: { GOOGLE_APPLICATION_CREDENTIALS: FIXTURE_ADC, GA4_ALLOW_WRITES: 'true' },
    });
    const { result, parsed } = await call('ga_create_key_event', {
      property_id: '200',
      event_name: 'sign_up',
      counting_method: 'ONCE_PER_EVENT',
    });
    expect(result.isError).toBe(true);
    expect(parsed.code).toBe('PERMISSION_DENIED');
    expect(parsed.error).toBe(
      '<untrusted-content source="ga4-api-error">The caller does not have permission</untrusted-content>',
    );
  });

  it('surfaces ALREADY_EXISTS when the resource is a duplicate', async () => {
    mswServer.use(
      http.post(`${ADMIN_HOST}/v1beta/properties/200/customDimensions`, () =>
        HttpResponse.json(
          { error: { message: 'Custom dimension already exists', status: 'ALREADY_EXISTS' } },
          { status: 409 },
        ),
      ),
    );
    testClient = await createTestClient({
      env: { GOOGLE_APPLICATION_CREDENTIALS: FIXTURE_ADC, GA4_ALLOW_WRITES: 'true' },
    });
    const { parsed } = await call('ga_create_custom_dimension', {
      property_id: '200',
      parameter_name: 'plan_tier',
      display_name: 'Plan tier',
      scope: 'EVENT',
    });
    expect(parsed.code).toBe('ALREADY_EXISTS');
  });
});

describe('read tools added alongside the writes', () => {
  it('ga_get_enhanced_measurement_settings reads without the write flag', async () => {
    const calls = await setup({ GA4_ALLOW_WRITES: '' });
    const { parsed } = await call('ga_get_enhanced_measurement_settings', { data_stream: '300' });
    expect(parsed.ok).toBe(true);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      version: 'v1alpha',
      path: 'properties/200/dataStreams/300/enhancedMeasurementSettings',
    });
  });

  it('ga_list_event_create_rules and ga_list_measurement_protocol_secrets envelope each item', async () => {
    mswServer.use(
      http.get(`${ADMIN_HOST}/v1alpha/properties/200/dataStreams/300/eventCreateRules`, () =>
        HttpResponse.json({
          eventCreateRules: [
            { name: 'properties/200/dataStreams/300/eventCreateRules/16', destinationEvent: 'demo_booked' },
          ],
        }),
      ),
      http.get(`${ADMIN_HOST}/v1beta/properties/200/dataStreams/300/measurementProtocolSecrets`, () =>
        HttpResponse.json({
          measurementProtocolSecrets: [
            { name: 'properties/200/dataStreams/300/measurementProtocolSecrets/17', displayName: 'Server', secretValue: 'abc' },
          ],
        }),
      ),
    );
    testClient = await createTestClient({
      env: { GOOGLE_APPLICATION_CREDENTIALS: FIXTURE_ADC, GA4_PROPERTY_ID: '200', GA4_ALLOW_WRITES: '' },
    });

    const rules = (await call('ga_list_event_create_rules', { data_stream: '300' })).parsed;
    const [rule] = rules.eventCreateRules as Array<{ name: string; rule: Record<string, string> }>;
    expect(rule.name).toBe('properties/200/dataStreams/300/eventCreateRules/16');
    expect(enveloped(rule.rule, 'destinationEvent')).toBe(
      '<untrusted-content source="ga4-admin">demo_booked</untrusted-content>',
    );

    const secrets = (await call('ga_list_measurement_protocol_secrets', { data_stream: '300' })).parsed;
    const [secret] = secrets.measurementProtocolSecrets as Array<{ name: string; secret: Record<string, string> }>;
    expect(secret.name).toBe('properties/200/dataStreams/300/measurementProtocolSecrets/17');
    expect(enveloped(secret.secret, 'displayName')).toBe(
      '<untrusted-content source="ga4-admin">Server</untrusted-content>',
    );
  });
});
