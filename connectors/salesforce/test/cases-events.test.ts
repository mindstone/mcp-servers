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

describe('Case tools — Salesforce MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('salesforce_get_cases returns cases with enveloped text fields', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_cases', { status: 'New' });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records.length).toBeGreaterThan(0);
    const record = result.json.records[0];
    expect(record.Id).toBe('500000000000001');
    expect(record.Subject).toBe(
      '<untrusted-content source="salesforce:get_cases:records">Login issue</untrusted-content>',
    );
  });

  it('salesforce_create_case creates a case', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_create_case', {
      subject: 'Cannot export report',
      priority: 'High',
      origin: 'Email',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'success');
    expect(result.json).toHaveProperty('object', 'Case');
    expect(result.json.id).toBeDefined();
  });

  it('salesforce_update_case updates a case', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_update_case', {
      id: '500000000000001AAA',
      status: 'Closed',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'success');
    expect(result.json).toHaveProperty('object', 'Case');
    expect(result.json).toHaveProperty('id', '500000000000001AAA');
  });

  it('salesforce_get_cases fails with structured error when unconfigured', async () => {
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

    const result = await testClient.callTool('salesforce_get_cases', {});
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json.code).toBe('UNCONFIGURED');
  });
});

describe('Event tools — Salesforce MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('salesforce_get_events returns events with enveloped text fields', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_events', {
      start_from: '2026-08-01',
      start_to: '2026-08-31',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records.length).toBeGreaterThan(0);
    const record = result.json.records[0];
    expect(record.Id).toBe('00U000000000001');
    expect(record.Subject).toBe(
      '<untrusted-content source="salesforce:get_events:records">Quarterly review</untrusted-content>',
    );
  });

  it('salesforce_get_events rejects a malformed start_from with an actionable error', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_events', { start_from: 'next Friday' });
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json.code).toBe('INVALID_DATE_FORMAT');
    expect(result.json.resolution).toContain('ISO 8601');
  });

  it('salesforce_create_event creates an event', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_create_event', {
      subject: 'Product demo',
      start_date_time: '2026-08-12T14:00:00Z',
      end_date_time: '2026-08-12T15:00:00Z',
      location: 'Video call',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'success');
    expect(result.json).toHaveProperty('object', 'Event');
    expect(result.json.id).toBeDefined();
  });

  it('salesforce_create_event rejects a malformed start_date_time', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_create_event', {
      subject: 'Bad event',
      start_date_time: 'tomorrow at noon',
      end_date_time: '2026-08-12T15:00:00Z',
    });
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json.code).toBe('INVALID_DATE_FORMAT');
  });
});
