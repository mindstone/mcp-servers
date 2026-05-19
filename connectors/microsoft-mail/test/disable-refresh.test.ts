import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

describe('MICROSOFT_DISABLE_REFRESH=1 fail-closed behaviour', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;
  let state: MockApiState;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir({
      expiresAt: Date.now() - 60_000,
      refreshToken: 'rt-1',
    });
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
        MICROSOFT_DISABLE_REFRESH: '1',
      },
    });
  });

  beforeEach(() => {
    const mock = createMockApi();
    state = mock.state;
    mswServer.use(...mock.handlers);
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('returns the host-orchestrated auth_required envelope when refresh is disabled', async () => {
    const result = await client.callTool('list_emails', { top: 1 });
    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      status: 'auth_required',
      user_action: { id: 'microsoft.connect_account' },
      setupToolName: 'authenticate_microsoft_account',
    });
  });

  it('makes zero token-refresh POSTs when MICROSOFT_DISABLE_REFRESH=1', async () => {
    await client.callTool('list_emails', { top: 1 });
    expect(state.refreshCalls).toBe(0);
  });
});
