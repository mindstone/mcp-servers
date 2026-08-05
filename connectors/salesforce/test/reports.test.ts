import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createSalesforceHandlers, MOCK_ACCESS_TOKEN, MOCK_INSTANCE_URL } from './helpers/salesforce-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';

function createAuthEnv(configPath: string): Record<string, string> {
  return {
    SALESFORCE_CLIENT_ID: 'mcp-test-client-id',
    SALESFORCE_CLIENT_SECRET: 'mcp-test-client-secret',
    SALESFORCE_CONFIG_DIR: configPath,
    MCP_HOST_BRIDGE_STATE: '',
  };
}

function createConfigWithToken() {
  return createTempConfig({
    accounts: [{ id: 'test-user', username: 'test@example.com', connected_at: new Date().toISOString() }],
    credentials: [{
      filename: 'test-user.token.json',
      data: {
        access_token: MOCK_ACCESS_TOKEN,
        refresh_token: 'mock-refresh',
        instance_url: MOCK_INSTANCE_URL,
        expires_at: Date.now() + 3600_000,
        username: 'test@example.com',
      },
    }],
  });
}

describe('Report tools — Salesforce MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('salesforce_run_report returns an enveloped report result; factMap keys stay raw', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_run_report', {
      report_id: '00O1a000005xYZ1AAM',
    });
    expect(result.json).toHaveProperty('ok', true);
    const report = result.json.report;
    expect(report.reportMetadata.name).toBe(
      '<untrusted-content source="salesforce:run_report:report">Pipeline by Stage</untrusted-content>',
    );
    // factMap keys are structural (T!T, 0!0) and must not be enveloped.
    expect(Object.keys(report.factMap)).toContain('T!T');
    expect(report.factMap['T!T'].aggregates[0].label).toBe(
      '<untrusted-content source="salesforce:run_report:report">50000</untrusted-content>',
    );
    // Default: no detail rows.
    expect(report.factMap['T!T'].rows).toEqual([]);
    expect(report.hasDetailRows).toBe(false);
  });

  it('salesforce_run_report with include_details=true returns detail rows', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_run_report', {
      report_id: '00O1a000005xYZ1AAM',
      include_details: true,
    });
    expect(result.json).toHaveProperty('ok', true);
    const rows = result.json.report.factMap['T!T'].rows;
    expect(rows.length).toBe(1);
    expect(rows[0].dataCells[0].label).toBe(
      '<untrusted-content source="salesforce:run_report:report">Big Deal</untrusted-content>',
    );
    expect(result.json.report.hasDetailRows).toBe(true);
  });

  it('salesforce_run_report rejects a malformed report_id before any API call', async () => {
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_run_report', { report_id: 'not a report id' });
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json.code).toBe('INVALID_REPORT_ID');
  });

  it('salesforce_run_report fails with structured error when unconfigured', async () => {
    tempConfig = createTempConfig({ empty: true });
    testClient = await createTestClient({
      env: {
        SALESFORCE_CLIENT_ID: '',
        SALESFORCE_CLIENT_SECRET: '',
        SALESFORCE_ACCESS_TOKEN: '',
        SALESFORCE_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('salesforce_run_report', { report_id: '00O1a000005xYZ1AAM' });
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json.code).toBe('UNCONFIGURED');
  });
});
