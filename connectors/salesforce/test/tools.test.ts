import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createSalesforceHandlers, MOCK_ACCESS_TOKEN, MOCK_INSTANCE_URL } from './helpers/salesforce-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone-engineering/mcp-test-harness';

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

describe('Tool tests — Salesforce MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('salesforce_get_contacts returns contacts via mock API', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_contacts', {});
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records).toBeDefined();
    expect(result.json.records.length).toBeGreaterThan(0);
    expect(result.json.records[0]).toHaveProperty('LastName', 'Doe');
  });

  it('salesforce_create_contact sends correct payload via mock', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_create_contact', {
      last_name: 'TestContact',
      first_name: 'New',
      email: 'new@test.com',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'success');
    expect(result.json).toHaveProperty('object', 'Contact');
    expect(result.json.id).toBeDefined();
  });

  it('salesforce_get_accounts returns accounts via mock', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_accounts', { limit: 10 });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records).toBeDefined();
  });

  it('salesforce_create_account creates an account', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_create_account', {
      name: 'New Corp',
      industry: 'Technology',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('object', 'Account');
  });

  it('salesforce_get_opportunities returns opportunities', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_opportunities', {});
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records).toBeDefined();
  });

  it('salesforce_list_objects returns objects list', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_list_objects', { custom_only: false });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.objects).toBeDefined();
    expect(result.json.count).toBeGreaterThan(0);
  });

  it('salesforce_describe_object returns metadata', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_describe_object', { object_name: 'Account' });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('name', 'Account');
    expect(result.json.fields).toBeDefined();
  });

  it('salesforce_query executes SOQL', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_query', {
      query: 'SELECT Id, Name FROM Account LIMIT 10',
    });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records).toBeDefined();
  });
});

describe('Error handling — Salesforce MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('returns structured error on unconfigured mode', async () => {
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

    const result = await testClient.callTool('salesforce_get_contacts', {});
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json.code).toBe('UNCONFIGURED');
    expect(result.json.resolution).toBeDefined();
  });

  it('returns guidance for list_connected_accounts in unconfigured mode', async () => {
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

    const result = await testClient.callTool('salesforce_list_connected_accounts', {});
    expect(result.json).toHaveProperty('auth_mode', 'unconfigured');
    expect(result.json.action_required).toBeDefined();
  });

  it('server stays alive after tool error', async () => {
    tempConfig = createTempConfig({ empty: true });
    testClient = await createTestClient({
      env: {
        SALESFORCE_CLIENT_ID: '',
        SALESFORCE_CLIENT_SECRET: '',
        SALESFORCE_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    // First call - should fail
    const result1 = await testClient.callTool('salesforce_get_contacts', {});
    expect(result1.json).toHaveProperty('ok', false);

    // Second call - server should still be alive
    const result2 = await testClient.callTool('salesforce_list_connected_accounts', {});
    expect(result2.json).toHaveProperty('auth_mode', 'unconfigured');
  });
});
