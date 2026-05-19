import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

/**
 * Files does NOT declare an `authenticate_microsoft_account` tool of its
 * own — the cohort decision is that Mail owns the M365 OAuth surface and the
 * host's `resolveMicrosoftAuthServerId()` routing redirects Files's setup
 * calls to Mail's running instance. What Files MUST still do is emit the
 * structured `auth_required` envelope whenever Graph returns a token error
 * (token_expired, refresh disabled, refresh failed), so the host's recovery
 * layer can dispatch into Mail's OAuth flow. Tests below assert both branches.
 */
describe('auth_required envelope on Graph token failure', () => {
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
    const result = await client.callTool('list_files', { top: 1 });
    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      status: 'auth_required',
      user_action: { id: 'microsoft.connect_account' },
      setupToolName: 'authenticate_microsoft_account',
    });
  });

  it('makes zero token-refresh POSTs when MICROSOFT_DISABLE_REFRESH=1', async () => {
    await client.callTool('list_files', { top: 1 });
    expect(state.refreshCalls).toBe(0);
  });

  it('auth_required envelope does NOT leak host-internal bridge vocabulary', async () => {
    const result = await client.callTool('list_files', { top: 1 });
    expect(result.text).not.toContain('auth_url');
    expect(result.text).not.toContain('authUrl');
    expect(result.text).not.toContain('/bundled/');
    expect(result.text).not.toContain('BRIDGE_STATE');
    expect(result.text).not.toContain('bridgeRequest');
  });
});
