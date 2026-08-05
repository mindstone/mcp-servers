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

describe('tool calls — happy path', () => {
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

  it('ga_list_account_summaries returns the mocked accounts', async () => {
    await setup();
    const result = await testClient.client.callTool({
      name: 'ga_list_account_summaries',
      arguments: {},
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    const summaries = parsed.accountSummaries as Array<{
      account: string;
      propertySummaries: Array<{ property: string }>;
    }>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0].account).toBe('accounts/100');
    expect(summaries[0].propertySummaries[0].property).toBe('properties/200');
  });

  it('ga_get_property_details returns mocked details', async () => {
    await setup();
    const result = await testClient.client.callTool({
      name: 'ga_get_property_details',
      arguments: { property_id: '200' },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.property_id).toBe('200');
    expect(parsed.currencyCode).toBe('USD');
  });

  it('ga_run_report applies a small report end-to-end', async () => {
    await setup();
    const result = await testClient.client.callTool({
      name: 'ga_run_report',
      arguments: {
        property_id: '200',
        dimensions: ['country'],
        metrics: ['totalUsers', 'sessions'],
        limit: 5,
      },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    const rows = parsed.rows as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      country: '<untrusted-content source="ga4-report">United Kingdom</untrusted-content>',
    });
  });

  it('ga_check_compatibility surfaces compatible dimensions and metrics', async () => {
    await setup();
    const result = await testClient.client.callTool({
      name: 'ga_check_compatibility',
      arguments: {
        property_id: '200',
        dimensions: ['country'],
        metrics: ['totalUsers'],
      },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    expect(
      (parsed.compatibleDimensions as Array<{ apiName: string }>)[0].apiName,
    ).toBe('country');
  });

  it('ga_search_schema finds dimensions and metrics by keyword', async () => {
    await setup();
    const result = await testClient.client.callTool({
      name: 'ga_search_schema',
      arguments: { property_id: '200', query: 'country' },
    });
    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    const results = parsed.results as Array<{ apiName: string; fieldType: string }>;
    expect(results.some((entry) => entry.apiName === 'country')).toBe(true);
  });
});

describe('error handling', () => {
  it('returns a friendly error when GOOGLE_APPLICATION_CREDENTIALS is missing', async () => {
    const client = await createTestClient({
      env: { GOOGLE_APPLICATION_CREDENTIALS: '' },
    });
    try {
      const result = await client.client.callTool({
        name: 'ga_list_account_summaries',
        arguments: {},
      });
      const parsed = parseToolResult(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('CREDENTIALS_NOT_CONFIGURED');
    } finally {
      await client.close();
    }
  });

  it('returns a friendly error when the credentials path is not absolute', async () => {
    const client = await createTestClient({
      env: { GOOGLE_APPLICATION_CREDENTIALS: 'relative/path.json' },
    });
    try {
      const result = await client.client.callTool({
        name: 'ga_list_account_summaries',
        arguments: {},
      });
      const parsed = parseToolResult(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('CREDENTIALS_PATH_NOT_ABSOLUTE');
    } finally {
      await client.close();
    }
  });

  it('returns a friendly error when the credentials file does not exist', async () => {
    const client = await createTestClient({
      env: {
        GOOGLE_APPLICATION_CREDENTIALS:
          '/var/empty/this-path-definitely-does-not-exist.json',
      },
    });
    try {
      const result = await client.client.callTool({
        name: 'ga_list_account_summaries',
        arguments: {},
      });
      const parsed = parseToolResult(result);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('CREDENTIALS_FILE_UNREADABLE');
    } finally {
      await client.close();
    }
  });
});
