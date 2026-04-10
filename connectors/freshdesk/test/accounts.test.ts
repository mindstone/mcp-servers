import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createFreshdeskHandlers,
  createFreshdeskBridgeHandlers,
  createFreshdeskBridge401Handlers,
  createFreshdeskBridge403Handlers,
  createFreshdeskBridgeFailureHandlers,
} from './helpers/freshdesk-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig } from '@mindstone-engineering/mcp-test-harness';
import { writeFileSync, readFileSync, statSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Freshdesk account management', () => {
  let testClient: McpTestClient;
  let cleanupConfig: () => void;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  it('list_freshdesk_accounts returns configured accounts', async () => {
    const tc = createTempConfig({
      accounts: [
        {
          domain: 'testacme',
          apiKey: 'mock-test-key',
          agentEmail: 'agent@testacme.freshdesk.com',
          authenticatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      defaultAccount: 'testacme',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tc.cleanup;
    mswServer.use(...createFreshdeskHandlers());

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_freshdesk_accounts',
      arguments: {},
    });
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0].domain).toBe('testacme');
    expect(parsed.accounts[0].agentEmail).toBe('agent@testacme.freshdesk.com');
    expect(parsed.accounts[0].url).toBe('https://testacme.freshdesk.com');
    expect(parsed.accounts[0].status).toBe('active');
    expect(parsed.defaultDomain).toBe('testacme');
  });

  it('remove_freshdesk_account disconnects an account', async () => {
    const tc = createTempConfig({
      accounts: [
        { domain: 'testacme', apiKey: 'mock-test-key' },
        { domain: 'removeme', apiKey: 'remove-key', agentEmail: 'agent@removeme.freshdesk.com' },
      ],
      defaultAccount: 'testacme',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tc.cleanup;
    mswServer.use(...createFreshdeskHandlers());

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'remove_freshdesk_account',
      arguments: { domain: 'removeme' },
    });
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('Disconnected removeme.freshdesk.com');
  });

  it('remove_freshdesk_account returns error for unknown domain', async () => {
    const tc = createTempConfig({
      accounts: [{ domain: 'testacme', apiKey: 'mock-test-key' }],
      defaultAccount: 'testacme',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tc.cleanup;
    mswServer.use(...createFreshdeskHandlers());

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'remove_freshdesk_account',
      arguments: { domain: 'nonexistent' },
    });
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('No account found');
  });
});

describe('Freshdesk multi-account system', () => {
  let testClient: McpTestClient;
  let cleanupConfig: () => void;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  it('uses default domain when no domain specified', async () => {
    const tc = createTempConfig({
      accounts: [
        { domain: 'acme', apiKey: 'acme-key' },
        { domain: 'beta', apiKey: 'beta-key' },
      ],
      defaultAccount: 'acme',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tc.cleanup;
    mswServer.use(...createFreshdeskHandlers('acme-key', 'acme'));

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_freshdesk_tickets',
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('acme.freshdesk.com/a/tickets/');
  });

  it('uses explicit domain when specified', async () => {
    const tc = createTempConfig({
      accounts: [
        { domain: 'acme', apiKey: 'acme-key' },
        { domain: 'beta', apiKey: 'beta-key' },
      ],
      defaultAccount: 'acme',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tc.cleanup;
    mswServer.use(
      ...createFreshdeskHandlers('acme-key', 'acme'),
      ...createFreshdeskHandlers('beta-key', 'beta'),
    );

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_freshdesk_tickets',
      arguments: { domain: 'beta' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('beta.freshdesk.com/a/tickets/');
  });

  it('lists both accounts', async () => {
    const tc = createTempConfig({
      accounts: [
        { domain: 'acme', apiKey: 'acme-key', agentEmail: 'a@acme.freshdesk.com' },
        { domain: 'beta', apiKey: 'beta-key', agentEmail: 'a@beta.freshdesk.com' },
      ],
      defaultAccount: 'acme',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tc.cleanup;

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.client.callTool({
      name: 'list_freshdesk_accounts',
      arguments: {},
    });
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );

    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.accounts[0].domain).toBe('acme');
    expect(parsed.accounts[1].domain).toBe('beta');
    expect(parsed.defaultDomain).toBe('acme');
  });
});

describe('Freshdesk hot-reload', () => {
  let testClient: McpTestClient;
  let cleanupConfig: () => void;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  it('picks up new accounts from accounts.json without restart', async () => {
    const tc = createTempConfig({
      accounts: [{ domain: 'original', apiKey: 'original-key' }],
      defaultAccount: 'original',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tc.cleanup;
    mswServer.use(
      ...createFreshdeskHandlers('original-key', 'original'),
      ...createFreshdeskHandlers('newdomain-key', 'newdomain'),
    );

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Verify one account
    let result = await testClient.client.callTool({
      name: 'list_freshdesk_accounts',
      arguments: {},
    });
    let parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsed.accounts).toHaveLength(1);

    // Write a new account to disk (simulating external update)
    writeFileSync(
      join(tc.configPath, 'accounts.json'),
      JSON.stringify({
        accounts: [
          { domain: 'original', apiKey: 'original-key' },
          { domain: 'newdomain', apiKey: 'newdomain-key' },
        ],
        defaultDomain: 'original',
      }),
      { mode: 0o600 },
    );

    // Should see both now (hot-reload)
    result = await testClient.client.callTool({
      name: 'list_freshdesk_accounts',
      arguments: {},
    });
    parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.accounts[1].domain).toBe('newdomain');

    // Using new domain works
    result = await testClient.client.callTool({
      name: 'list_freshdesk_tickets',
      arguments: { domain: 'newdomain' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('newdomain.freshdesk.com/a/tickets/');
  });
});

describe('Freshdesk file permissions', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('accounts.json is saved with mode 0o600', async () => {
    const tc = createTempConfig({
      accounts: [],
      defaultAccountKey: 'defaultDomain',
    });
    mswServer.use(...createFreshdeskHandlers());

    try {
      testClient = await createTestClient({
        env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.client.callTool({
        name: 'configure_freshdesk',
        arguments: { domain: 'permtest', api_key: 'perm-key' },
      });

      const stats = statSync(join(tc.configPath, 'accounts.json'));
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      tc.cleanup();
    }
  });

  it('config directory is created with mode 0o700', async () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'freshdesk-perm-'));
    const nonExistentPath = join(parentDir, 'freshdesk-config');
    mswServer.use(...createFreshdeskHandlers());

    try {
      testClient = await createTestClient({
        env: { FRESHDESK_CONFIG_PATH: nonExistentPath, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.client.callTool({
        name: 'configure_freshdesk',
        arguments: { domain: 'dirtest', api_key: 'dir-key' },
      });

      const stats = statSync(nonExistentPath);
      expect(stats.mode & 0o777).toBe(0o700);
    } finally {
      try { rmSync(parentDir, { recursive: true }); } catch { /* ignore */ }
    }
  });
});

describe('Freshdesk bridge integration', () => {
  const BRIDGE_PORT = 19876;
  const BRIDGE_TOKEN = 'test-bridge-token';
  let testClient: McpTestClient;
  let cleanupConfig: () => void;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (cleanupConfig) cleanupConfig();
    vi.unstubAllEnvs();
  });

  it('configure_freshdesk uses bridge when MCP_HOST_BRIDGE_STATE is set', async () => {
    const tc = createTempConfig({ accounts: [], defaultAccountKey: 'defaultDomain' });
    cleanupConfig = tc.cleanup;

    const bridgePath = join(tc.configPath, 'bridge-state.json');
    writeFileSync(bridgePath, JSON.stringify({ port: BRIDGE_PORT, token: BRIDGE_TOKEN }));

    mswServer.use(
      ...createFreshdeskHandlers(),
      ...createFreshdeskBridgeHandlers(BRIDGE_PORT, BRIDGE_TOKEN),
    );

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: bridgePath },
    });

    const result = await testClient.client.callTool({
      name: 'configure_freshdesk',
      arguments: { domain: 'bridgetest', api_key: 'bridge-key' },
    });
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('bridgetest.freshdesk.com');
  });

  it('bridge 401 returns isError: true', async () => {
    const tc = createTempConfig({ accounts: [], defaultAccountKey: 'defaultDomain' });
    cleanupConfig = tc.cleanup;

    const bridgePath = join(tc.configPath, 'bridge-state.json');
    writeFileSync(bridgePath, JSON.stringify({ port: BRIDGE_PORT, token: BRIDGE_TOKEN }));

    mswServer.use(...createFreshdeskBridge401Handlers(BRIDGE_PORT));

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: bridgePath },
    });

    const result = await testClient.client.callTool({
      name: 'configure_freshdesk',
      arguments: { domain: 'test401', api_key: 'mcp-test-freshdesk-key' },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('BRIDGE_ERROR');
  });

  it('bridge 403 returns isError: true', async () => {
    const tc = createTempConfig({ accounts: [], defaultAccountKey: 'defaultDomain' });
    cleanupConfig = tc.cleanup;

    const bridgePath = join(tc.configPath, 'bridge-state.json');
    writeFileSync(bridgePath, JSON.stringify({ port: BRIDGE_PORT, token: BRIDGE_TOKEN }));

    mswServer.use(...createFreshdeskBridge403Handlers(BRIDGE_PORT));

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: bridgePath },
    });

    const result = await testClient.client.callTool({
      name: 'configure_freshdesk',
      arguments: { domain: 'test403', api_key: 'mcp-test-freshdesk-key' },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('BRIDGE_ERROR');
  });

  it('bridge { success: false } returns isError: true', async () => {
    const tc = createTempConfig({ accounts: [], defaultAccountKey: 'defaultDomain' });
    cleanupConfig = tc.cleanup;

    const bridgePath = join(tc.configPath, 'bridge-state.json');
    writeFileSync(bridgePath, JSON.stringify({ port: BRIDGE_PORT, token: BRIDGE_TOKEN }));

    mswServer.use(...createFreshdeskBridgeFailureHandlers(BRIDGE_PORT, BRIDGE_TOKEN));

    testClient = await createTestClient({
      env: { FRESHDESK_CONFIG_PATH: tc.configPath, MCP_HOST_BRIDGE_STATE: bridgePath },
    });

    const result = await testClient.client.callTool({
      name: 'configure_freshdesk',
      arguments: { domain: 'testfail', api_key: 'mcp-test-freshdesk-key' },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('BRIDGE_ERROR');
  });
});
