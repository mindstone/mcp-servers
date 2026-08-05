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

const ADMIN_BETA = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA_BETA = 'https://analyticsdata.googleapis.com/v1beta';
const DATA_ALPHA = 'https://analyticsdata.googleapis.com/v1alpha';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function apiError(status: number, code: string, message: string) {
  return () => HttpResponse.json({ error: { message, status: code } }, { status });
}

interface TextContent {
  type: 'text';
  text: string;
}

function parseToolResult(result: { content: unknown }) {
  const content = result.content as TextContent[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe('error paths', () => {
  let testClient: McpTestClient;

  async function setup(
    extraHandlers: Parameters<typeof mswServer.use> = [],
    env: Record<string, string> = {},
  ) {
    // Two separate use() calls: later calls take precedence over the defaults.
    mswServer.use(...createGoogleHandlers());
    if (extraHandlers.length) mswServer.use(...extraHandlers);
    testClient = await createTestClient({
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: FIXTURE_ADC,
        GA4_PROPERTY_ID: '200',
        ...env,
      },
    });
  }

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  async function callError(name: string, args: Record<string, unknown> = {}) {
    const result = await testClient.client.callTool({ name, arguments: args });
    const parsed = parseToolResult(result);
    expect(parsed.ok, `${name} should fail`).toBe(false);
    expect(result.isError, `${name} should set isError`).toBe(true);
    return parsed;
  }

  it('surfaces RESOURCE_EXHAUSTED when the Data API returns 429 quota exhaustion', async () => {
    await setup([
      http.post(
        new RegExp(`^${escapeRegex(DATA_BETA)}/properties/[^/]+:runReport$`),
        apiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for concurrent requests.'),
      ),
    ]);
    const parsed = await callError('ga_run_report', {
      property_id: '200',
      metrics: ['totalUsers'],
    });
    expect(parsed.code).toBe('RESOURCE_EXHAUSTED');
    expect(String(parsed.error)).toContain('Quota exceeded');
    expect(String(parsed.resolution)).toContain('credential');
  });

  it('surfaces NOT_FOUND when the property does not exist', async () => {
    await setup([
      http.get(
        new RegExp(`^${escapeRegex(ADMIN_BETA)}/properties/[^/]+$`),
        apiError(404, 'NOT_FOUND', 'Requested entity was not found.'),
      ),
    ]);
    const parsed = await callError('ga_get_property_details', { property_id: '999' });
    expect(parsed.code).toBe('NOT_FOUND');
  });

  it('surfaces INVALID_ARGUMENT for an unknown dimension', async () => {
    await setup([
      http.post(
        new RegExp(`^${escapeRegex(DATA_BETA)}/properties/[^/]+:runReport$`),
        apiError(400, 'INVALID_ARGUMENT', 'Did you mean country? Field notADimension is not a valid dimension.'),
      ),
    ]);
    const parsed = await callError('ga_run_report', {
      property_id: '200',
      dimensions: ['notADimension'],
      metrics: ['totalUsers'],
    });
    expect(parsed.code).toBe('INVALID_ARGUMENT');
    expect(String(parsed.error)).toContain('notADimension');
  });

  it('surfaces PERMISSION_DENIED with a resolution hint', async () => {
    await setup([
      http.get(
        new RegExp(`^${escapeRegex(ADMIN_BETA)}/accountSummaries$`),
        apiError(403, 'PERMISSION_DENIED', 'User does not have sufficient permissions.'),
      ),
    ]);
    const parsed = await callError('ga_list_account_summaries');
    expect(parsed.code).toBe('PERMISSION_DENIED');
  });

  it('fails fast with PROPERTY_ID_REQUIRED when no property is available', async () => {
    await setup([], { GA4_PROPERTY_ID: '' });
    const parsed = await callError('ga_run_report', { metrics: ['totalUsers'] });
    expect(parsed.code).toBe('PROPERTY_ID_REQUIRED');
  });

  it('surfaces FAILED_PRECONDITION when querying an audience export that is not ACTIVE', async () => {
    await setup([
      http.post(
        new RegExp(`^${escapeRegex(DATA_BETA)}/properties/[^/]+/audienceExports/[^/]+:query$`),
        apiError(400, 'FAILED_PRECONDITION', 'Audience export is still being created.'),
      ),
    ]);
    const parsed = await callError('ga_query_audience_export', { export_id: '700' });
    expect(parsed.code).toBe('FAILED_PRECONDITION');
  });

  it('surfaces FAILED_PRECONDITION when querying a report task that is not ACTIVE', async () => {
    await setup([
      http.post(
        new RegExp(`^${escapeRegex(DATA_ALPHA)}/properties/[^/]+/reportTasks/[^/]+:query$`),
        apiError(400, 'FAILED_PRECONDITION', 'Report task is not ACTIVE.'),
      ),
    ]);
    const parsed = await callError('ga_query_report_task', { task_id: '800' });
    expect(parsed.code).toBe('FAILED_PRECONDITION');
  });

  it('warns instead of fetching when the estimated row count exceeds the threshold', async () => {
    await setup([
      http.post(new RegExp(`^${escapeRegex(DATA_BETA)}/properties/[^/]+:runReport$`), () =>
        HttpResponse.json({ rowCount: 5000 }),
      ),
    ]);
    const result = await testClient.client.callTool({
      name: 'ga_run_report',
      arguments: { property_id: '200', dimensions: ['country'], metrics: ['totalUsers'] },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.warning).toBe(true);
    expect(parsed.estimatedRows).toBe(5000);
    expect(parsed.rows).toBeUndefined();
    expect((parsed.suggestions as string[]).length).toBeGreaterThan(0);
  });

  it('estimate_only returns the row estimate without fetching rows', async () => {
    await setup([
      http.post(new RegExp(`^${escapeRegex(DATA_BETA)}/properties/[^/]+:runReport$`), () =>
        HttpResponse.json({ rowCount: 5000 }),
      ),
    ]);
    const result = await testClient.client.callTool({
      name: 'ga_run_report',
      arguments: {
        property_id: '200',
        dimensions: ['country'],
        metrics: ['totalUsers'],
        estimate_only: true,
      },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.estimatedRows).toBe(5000);
    expect(parsed.rows).toBeUndefined();
  });
});
