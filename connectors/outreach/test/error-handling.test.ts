import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createOutreachHandlers, MOCK_ACCESS_TOKEN } from './helpers/outreach-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone-engineering/mcp-test-harness';

function setupAuth() {
  return createTempConfig({
    accounts: [
      {
        id: 'test-user',
        username: 'test@example.com',
        connected_at: new Date().toISOString(),
      },
    ],
    credentials: [
      {
        filename: 'test-user.token.json',
        data: {
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: 'mock-refresh',
          expires_at: Date.now() + 3600_000,
          scope: 'prospects.all',
          created_at: Date.now(),
          username: 'test@example.com',
        },
      },
    ],
  });
}

describe('Error handling — Outreach MCP server', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('API 401 returns structured error with resolution', async () => {
    mswServer.use(...createOutreachHandlers());
    // Override the prospects endpoint to always return 401
    mswServer.use(
      http.get('https://api.outreach.io/api/v2/prospects', () => {
        return HttpResponse.json(
          { errors: [{ title: 'Unauthorized', detail: 'Invalid token' }] },
          { status: 401 },
        );
      }),
    );

    tempConfig = setupAuth();
    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_search_prospects', {});
    expect(result.isError).toBe(true);
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'HTTP_401');
    expect(result.json).toHaveProperty('resolution');
  });

  it('API 404 returns structured error', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_get_prospect', { id: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'HTTP_404');
  });

  it('API 500 returns structured error, server stays alive', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    // Trigger 500
    const errorResult = await testClient.callTool('outreach_get_prospect', { id: 'trigger-500' });
    expect(errorResult.isError).toBe(true);
    expect(errorResult.json).toHaveProperty('ok', false);

    // Server stays alive — subsequent call works
    const okResult = await testClient.callTool('outreach_get_prospect', { id: '101' });
    expect(okResult.isError).toBeFalsy();
    expect(okResult.json).toHaveProperty('ok', true);
  });

  it('unconfigured mode returns setup guidance, not crash', async () => {
    tempConfig = createTempConfig({ empty: true });

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: '',
        OUTREACH_CLIENT_SECRET: '',
        OUTREACH_ACCESS_TOKEN: '',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('outreach_search_prospects', {});
    expect(result.isError).toBe(true);
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'UNCONFIGURED');
    expect(result.json).toHaveProperty('resolution');
    const resolution = (result.json as Record<string, unknown>).resolution as string;
    expect(resolution).toContain('OUTREACH_CLIENT_ID');
  });

  it('outreach_create_prospect validates required fields', async () => {
    mswServer.use(...createOutreachHandlers());
    tempConfig = setupAuth();

    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    // Missing both email and last_name
    const result = await testClient.callTool('outreach_create_prospect', {
      first_name: 'Jane',
    });
    expect(result.isError).toBe(true);
    expect(result.json).toHaveProperty('ok', false);
    expect(result.json).toHaveProperty('code', 'VALIDATION_ERROR');
  });
});
