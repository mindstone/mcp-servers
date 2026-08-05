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

describe('Campaign tools — Salesforce MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('salesforce_get_campaigns returns campaigns with enveloped text fields', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_campaigns', { is_active: true });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records.length).toBeGreaterThan(0);
    const record = result.json.records[0];
    expect(record.Id).toBe('701000000000001');
    expect(record.Name).toBe(
      '<untrusted-content source="salesforce:get_campaigns:records">Q3 Webinar Series</untrusted-content>',
    );
  });

  it('salesforce_get_campaign_members returns members with raw IDs and enveloped status', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_campaign_members', {
      campaign_id: '701000000000001AAA',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records.length).toBeGreaterThan(0);
    const record = result.json.records[0];
    expect(record.Id).toBe('00v000000000001');
    expect(record.CampaignId).toBe('701000000000001');
    expect(record.ContactId).toBe('003000000000001');
    expect(record.Status).toBe(
      '<untrusted-content source="salesforce:get_campaign_members:records">Sent</untrusted-content>',
    );
  });

  it('salesforce_get_campaigns fails with structured error when unconfigured', async () => {
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

    const result = await testClient.callTool('salesforce_get_campaigns', {});
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json.code).toBe('UNCONFIGURED');
  });
});
