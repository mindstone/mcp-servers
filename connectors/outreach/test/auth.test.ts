import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';

describe('Auth mode detection — Outreach MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('detects bridge mode when MCP_HOST_BRIDGE_STATE is set', async () => {
    tempConfig = createTempConfig({ empty: true });
    const bridgePath = path.join(tempConfig.configPath, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test' }));

    testClient = await createTestClient({
      env: {
        MCP_HOST_BRIDGE_STATE: bridgePath,
        OUTREACH_CLIENT_ID: 'test-id',
        OUTREACH_CLIENT_SECRET: 'test-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
      },
    });

    const result = await testClient.callTool('outreach_list_connected_accounts', {});
    expect(result.json).toHaveProperty('auth_mode', 'bridge');
  });

  it('detects standalone_oauth mode when CLIENT_ID and SECRET set, no bridge', async () => {
    tempConfig = createTempConfig({ empty: true });

    testClient = await createTestClient({
      env: {
        MCP_HOST_BRIDGE_STATE: '',
        OUTREACH_CLIENT_ID: 'test-id',
        OUTREACH_CLIENT_SECRET: 'test-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
      },
    });

    const result = await testClient.callTool('outreach_list_connected_accounts', {});
    expect(result.json).toHaveProperty('auth_mode', 'standalone_oauth');
  });

  it('detects manual_token mode when only OUTREACH_ACCESS_TOKEN set', async () => {
    tempConfig = createTempConfig({ empty: true });

    testClient = await createTestClient({
      env: {
        MCP_HOST_BRIDGE_STATE: '',
        OUTREACH_CLIENT_ID: '',
        OUTREACH_CLIENT_SECRET: '',
        OUTREACH_ACCESS_TOKEN: 'some-manual-token',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
      },
    });

    const result = await testClient.callTool('outreach_list_connected_accounts', {});
    expect(result.json).toHaveProperty('auth_mode', 'manual_token');
  });

  it('detects unconfigured mode when no auth env vars set', async () => {
    tempConfig = createTempConfig({ empty: true });

    testClient = await createTestClient({
      env: {
        MCP_HOST_BRIDGE_STATE: '',
        OUTREACH_CLIENT_ID: '',
        OUTREACH_CLIENT_SECRET: '',
        OUTREACH_ACCESS_TOKEN: '',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
      },
    });

    const result = await testClient.callTool('outreach_list_connected_accounts', {});
    expect(result.json).toHaveProperty('auth_mode', 'unconfigured');
  });

  it('bridge takes precedence over standalone_oauth', async () => {
    tempConfig = createTempConfig({ empty: true });
    const bridgePath = path.join(tempConfig.configPath, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test' }));

    testClient = await createTestClient({
      env: {
        MCP_HOST_BRIDGE_STATE: bridgePath,
        OUTREACH_CLIENT_ID: 'test-id',
        OUTREACH_CLIENT_SECRET: 'test-secret',
        OUTREACH_ACCESS_TOKEN: 'manual-token',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
      },
    });

    const result = await testClient.callTool('outreach_list_connected_accounts', {});
    expect(result.json).toHaveProperty('auth_mode', 'bridge');
  });

  it('standalone_oauth takes precedence over manual_token', async () => {
    tempConfig = createTempConfig({ empty: true });

    testClient = await createTestClient({
      env: {
        MCP_HOST_BRIDGE_STATE: '',
        OUTREACH_CLIENT_ID: 'test-id',
        OUTREACH_CLIENT_SECRET: 'test-secret',
        OUTREACH_ACCESS_TOKEN: 'manual-token',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
      },
    });

    const result = await testClient.callTool('outreach_list_connected_accounts', {});
    expect(result.json).toHaveProperty('auth_mode', 'standalone_oauth');
  });
});

describe('Token persistence — Outreach MCP server', () => {
  let tempConfig: TempConfigResult;

  afterEach(() => {
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('creates config directory with mode 0o700 when missing', async () => {
    const basePath = fs.mkdtempSync('/tmp/outreach-test-');
    const configPath = path.join(basePath, 'nonexistent', 'config');

    // Stub env, reset modules, and import auth module
    vi.stubEnv('OUTREACH_CONFIG_DIR', configPath);
    vi.stubEnv('OUTREACH_CLIENT_ID', 'test-id');
    vi.stubEnv('OUTREACH_CLIENT_SECRET', 'test-secret');
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.resetModules();

    const { loadAccounts } = await import('../src/auth.js');
    loadAccounts();

    expect(fs.existsSync(configPath)).toBe(true);
    const stats = fs.statSync(configPath);
    expect(stats.mode & 0o777).toBe(0o700);

    // Cleanup
    fs.rmSync(basePath, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('writes token files with mode 0o600', async () => {
    const basePath = fs.mkdtempSync('/tmp/outreach-test-');
    const configPath = path.join(basePath, 'config');

    vi.stubEnv('OUTREACH_CONFIG_DIR', configPath);
    vi.stubEnv('OUTREACH_CLIENT_ID', 'test-id');
    vi.stubEnv('OUTREACH_CLIENT_SECRET', 'test-secret');
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.resetModules();

    const { saveToken } = await import('../src/auth.js');
    saveToken('test-account', {
      access_token: 'tok',
      refresh_token: 'ref',
      expires_at: Date.now() + 3600_000,
      scope: 'all',
      created_at: Date.now(),
      username: 'test',
    });

    const tokenPath = path.join(configPath, 'credentials', 'test-account.token.json');
    expect(fs.existsSync(tokenPath)).toBe(true);
    const stats = fs.statSync(tokenPath);
    expect(stats.mode & 0o777).toBe(0o600);

    // Cleanup
    fs.rmSync(basePath, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('disconnect removes token file and updates accounts', async () => {
    tempConfig = createTempConfig({
      accounts: [
        {
          id: 'user-to-remove',
          username: 'remove@test.com',
          connected_at: new Date().toISOString(),
        },
      ],
      credentials: [
        {
          filename: 'user-to-remove.token.json',
          data: {
            access_token: 'tok',
            refresh_token: 'ref',
            expires_at: Date.now() + 3600_000,
            scope: 'all',
            created_at: Date.now(),
          },
        },
      ],
    });

    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.stubEnv('OUTREACH_CLIENT_ID', 'test-id');
    vi.stubEnv('OUTREACH_CLIENT_SECRET', 'test-secret');
    vi.stubEnv('OUTREACH_CONFIG_DIR', tempConfig.configPath);
    vi.resetModules();

    const { createServer } = await import('../src/server.js');
    const { createInMemoryTestClient } = await import('@mindstone/mcp-test-harness');
    const client = await createInMemoryTestClient({ createServer });

    const result = await client.callTool('outreach_disconnect_account', {
      username: 'remove@test.com',
    });
    expect(result.json).toHaveProperty('ok', true);

    // Verify token file is removed
    const tokenPath = path.join(tempConfig.configPath, 'credentials', 'user-to-remove.token.json');
    expect(fs.existsSync(tokenPath)).toBe(false);

    // Verify accounts updated
    const accountsPath = path.join(tempConfig.configPath, 'accounts.json');
    const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
    expect(accounts.accounts).toHaveLength(0);

    await client.close();
    vi.unstubAllEnvs();
  });
});
