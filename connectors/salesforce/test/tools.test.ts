import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
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

/**
 * Bridge-mode env: the host app owns OAuth and does NOT pass the OAuth client
 * credentials (CLIENT_ID/SECRET) into the connector's environment. A token file
 * with a refresh_token still exists. This is the production configuration that
 * regressed — see docs/plans/260612_fix-salesforce-bridge-refresh-token/.
 */
function createBridgeEnv(configPath: string): Record<string, string> {
  const bridgePath = path.join(configPath, 'bridge.json');
  fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test' }));
  return {
    MCP_HOST_BRIDGE_STATE: bridgePath,
    SALESFORCE_CONFIG_DIR: configPath,
    // Explicitly absent in bridge mode — override any ambient values.
    SALESFORCE_CLIENT_ID: '',
    SALESFORCE_CLIENT_SECRET: '',
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
    // Record text fields are enveloped (FOX-3490); IDs stay raw.
    expect(result.json.records[0].LastName).toBe(
      '<untrusted-content source="salesforce:get_contacts:records">Doe</untrusted-content>',
    );
    expect(result.json.records[0]).toHaveProperty('Id', '003000000000001');
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

  it('salesforce_update_contact issues PATCH against /sobjects/Contact/<id> (VAL-SALESFORCE-001, VAL-SALESFORCE-006)', async () => {
    const observedRequests: { method: string; pathname: string }[] = [];

    // Record every request so we can assert path-routing post-fix.
    mswServer.events.removeAllListeners();
    const recordRequest = ({ request }: { request: Request }) => {
      const u = new URL(request.url);
      observedRequests.push({ method: request.method, pathname: u.pathname });
    };
    mswServer.events.on('request:start', recordRequest);

    // Catch-all handler that fails the test if anything is PATCHed against /sobjects/Account/<id>.
    const accountTrap = http.patch(
      '*/services/data/:version/sobjects/Account/:id',
      () => {
        throw new Error('VAL-SALESFORCE-001 violation: PATCH against /sobjects/Account/ — update_contact must target Contact.');
      },
    );

    // Explicit Contact-update handler returning the canonical 204.
    const contactUpdate = http.patch(
      '*/services/data/:version/sobjects/Contact/:id',
      () => new HttpResponse(null, { status: 204 }),
    );

    // Order matters in msw: more-specific first; then defaults from createSalesforceHandlers.
    mswServer.use(contactUpdate, accountTrap, ...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const targetId = '003000000000001AAA';
    const result = await testClient.callTool('salesforce_update_contact', {
      id: targetId,
      first_name: 'NewName',
    });

    mswServer.events.removeListener('request:start', recordRequest);

    expect(result.json).toHaveProperty('ok', true);
    expect(result.json).toHaveProperty('status', 'success');
    expect(result.json).toHaveProperty('object', 'Contact');
    expect(result.json).toHaveProperty('id', targetId);

    const patches = observedRequests.filter((r) => r.method === 'PATCH');
    const contactPatches = patches.filter((r) =>
      /\/services\/data\/v\d+\.\d+\/sobjects\/Contact\/003000000000001AAA$/.test(r.pathname),
    );
    const accountPatches = patches.filter((r) => r.pathname.includes('/sobjects/Account/'));
    expect(contactPatches.length).toBeGreaterThanOrEqual(1);
    expect(accountPatches.length).toBe(0);
  });

  it('salesforce_get_accounts returns accounts via mock', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_accounts', { limit: 10 });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records).toBeDefined();
  });

  // Regression: in bridge mode the host owns OAuth and does not pass
  // SALESFORCE_CLIENT_ID/SECRET to the connector. A refresh_token is present in
  // the token file. The connector must NOT hand jsforce a refresh token without
  // OAuth2 client info — doing so throws at construction:
  // "Refresh token is specified without oauth2 client information or refresh function".
  // See docs/plans/260612_fix-salesforce-bridge-refresh-token/.
  it('salesforce tool calls succeed in bridge mode without OAuth client credentials', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createBridgeEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_accounts', { limit: 10 });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records).toBeDefined();
  });

  // Guards the POSITIVE branch of the bridge fix: standalone_oauth mode (and
  // bridge-with-creds) must STILL attach refreshToken so jsforce auto-refreshes.
  // A stale access token forces a 401; jsforce refreshes against the mocked
  // login.salesforce.com token endpoint and retries. If a future change dropped
  // refreshToken from the credentialed path, jsforce couldn't refresh and this
  // would surface SESSION_EXPIRED instead of ok:true. (non-sandbox instance_url
  // so the refresh hits login.salesforce.com, which the mock serves.)
  it('standalone OAuth mode still auto-refreshes an expired access token', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createTempConfig({
      accounts: [{ id: 'test-user', username: 'test@example.com', connected_at: new Date().toISOString() }],
      credentials: [{
        filename: 'test-user.token.json',
        data: {
          access_token: 'stale-access-token',
          refresh_token: 'mock-refresh',
          instance_url: 'https://example.my.salesforce.com',
          expires_at: Date.now() + 3600_000,
          username: 'test@example.com',
        },
      }],
    });
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_accounts', { limit: 10 });
    expect(result.json).toHaveProperty('ok', true);
    expect(result.json.records).toBeDefined();
  });

  // Bridge mode with an expired access token and no way to refresh (host owns
  // OAuth) must degrade GRACEFULLY to SESSION_EXPIRED (prompting reconnect),
  // not crash. The 401 maps through withConnection() to a structured error.
  it('bridge mode surfaces SESSION_EXPIRED on an expired token instead of crashing', async () => {
    mswServer.use(...createSalesforceHandlers());
    tempConfig = createTempConfig({
      accounts: [{ id: 'test-user', username: 'test@example.com', connected_at: new Date().toISOString() }],
      credentials: [{
        filename: 'test-user.token.json',
        data: {
          access_token: 'expired-access-token',
          refresh_token: 'mock-refresh',
          instance_url: MOCK_INSTANCE_URL,
          expires_at: Date.now() + 3600_000,
          username: 'test@example.com',
        },
      }],
    });
    testClient = await createTestClient({ env: createBridgeEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_accounts', { limit: 10 });
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'SESSION_EXPIRED');
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
