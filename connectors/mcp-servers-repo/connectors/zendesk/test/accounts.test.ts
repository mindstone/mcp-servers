import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTempConfig, createBridgeHandlers } from '@mindstone-engineering/mcp-test-harness';
import { mswServer } from './helpers/setup.js';
import { createZendeskHandlers } from './helpers/zendesk-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { API_TOKEN_ACCOUNT } from './fixtures/accounts.js';

describe('Account tools — list_zendesk_accounts', () => {
  let testClient: McpTestClient;
  let cleanup: () => void;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
    if (cleanup) cleanup();
  });

  it('should return configured accounts', async () => {
    const tempConfig = createTempConfig({
      accounts: [API_TOKEN_ACCOUNT],
      defaultAccount: API_TOKEN_ACCOUNT.subdomain,
      prefix: 'zendesk-test-',
    });
    cleanup = tempConfig.cleanup;
    mswServer.use(...createZendeskHandlers(API_TOKEN_ACCOUNT.subdomain));

    testClient = await createTestClient({
      env: {
        ZENDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_zendesk_accounts', {});
    expect(result.isError).toBeFalsy();
    const data = result.json as any;
    expect(data.ok).toBe(true);
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0].subdomain).toBe('testcorp');
    expect(data.accounts[0].authType).toBe('api-token');
    expect(data.accounts[0].status).toBe('active');
  });
});

describe('Account tools — list_zendesk_accounts (empty)', () => {
  let testClient: McpTestClient;
  let cleanup: () => void;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
    if (cleanup) cleanup();
  });

  it('should return empty message when no accounts configured', async () => {
    const tempConfig = createTempConfig({ empty: true, prefix: 'zendesk-test-' });
    cleanup = tempConfig.cleanup;

    testClient = await createTestClient({
      env: {
        ZENDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_zendesk_accounts', {});
    expect(result.isError).toBeFalsy();
    const data = result.json as any;
    expect(data.ok).toBe(true);
    expect(data.accounts).toHaveLength(0);
    expect(data.message).toContain('No Zendesk accounts connected');
  });
});

describe('Account tools — remove_zendesk_account', () => {
  let testClient: McpTestClient;
  let cleanup: () => void;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
    if (cleanup) cleanup();
  });

  it('should remove account', async () => {
    const tempConfig = createTempConfig({
      accounts: [API_TOKEN_ACCOUNT],
      defaultAccount: API_TOKEN_ACCOUNT.subdomain,
      prefix: 'zendesk-test-',
    });
    cleanup = tempConfig.cleanup;
    mswServer.use(...createZendeskHandlers(API_TOKEN_ACCOUNT.subdomain));

    testClient = await createTestClient({
      env: {
        ZENDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('remove_zendesk_account', {
      subdomain: 'testcorp',
    });
    expect(result.isError).toBeFalsy();
    const data = result.json as any;
    expect(data.ok).toBe(true);
    expect(data.message).toContain('Disconnected');
  });
});

describe('Account tools — authenticate_zendesk_account', () => {
  let testClient: McpTestClient;
  let cleanup: () => void;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
    if (cleanup) cleanup();
  });

  it('should authenticate via bridge', async () => {
    const bridgePort = 19876;
    const bridgeToken = 'test-bridge-token';
    const tempConfig = createTempConfig({ empty: true, prefix: 'zendesk-test-' });
    cleanup = tempConfig.cleanup;

    // Write bridge state file
    const bridgeState = { port: bridgePort, token: bridgeToken };
    fs.writeFileSync(tempConfig.bridgeStatePath, JSON.stringify(bridgeState));

    mswServer.use(
      ...createBridgeHandlers(bridgePort, {
        successData: { configured: true },
      }),
      ...createZendeskHandlers('newcorp'),
    );

    testClient = await createTestClient({
      env: {
        ZENDESK_CONFIG_PATH: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: tempConfig.bridgeStatePath,
      },
    });

    const result = await testClient.callTool('authenticate_zendesk_account', {
      subdomain: 'newcorp',
      email: 'agent@newcorp.com',
      api_token: 'new-api-token',
    });
    expect(result.isError).toBeFalsy();
    const data = result.json as any;
    expect(data.ok).toBe(true);
    expect(data.message).toContain('newcorp');
  });
});
