import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

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
    const result = await client.callTool('list_chats', { top: 1 });
    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      status: 'auth_required',
      user_action: { id: 'microsoft.connect_account' },
      setupToolName: 'authenticate_microsoft_account',
    });
  });

  it('makes zero token-refresh POSTs when MICROSOFT_DISABLE_REFRESH=1', async () => {
    await client.callTool('list_chats', { top: 1 });
    expect(state.refreshCalls).toBe(0);
  });

  it('auth_required envelope does NOT leak host-internal bridge vocabulary', async () => {
    const result = await client.callTool('list_chats', { top: 1 });
    expect(result.text).not.toContain('auth_url');
    expect(result.text).not.toContain('authUrl');
    expect(result.text).not.toContain('/bundled/');
    expect(result.text).not.toContain('BRIDGE_STATE');
    expect(result.text).not.toContain('bridgeRequest');
  });
});

describe('auth_required envelope on refresh failure', () => {
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
        MICROSOFT_DISABLE_REFRESH: '0',
      },
    });
  });

  beforeEach(() => {
    const mock = createMockApi();
    state = mock.state;
    mswServer.use(
      http.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', async ({ request }) => {
        state.refreshCalls += 1;
        const body = await request.text();
        state.requests.push({
          method: request.method,
          url: request.url,
          pathname: new URL(request.url).pathname,
          search: new URL(request.url).search,
          body: Object.fromEntries(new URLSearchParams(body).entries()),
          authorization: request.headers.get('authorization') ?? undefined,
        });
        return HttpResponse.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'Upstream token service unavailable.',
          },
          { status: 503 },
        );
      }),
      ...mock.handlers,
    );
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('returns auth_required when refresh attempt fails', async () => {
    const result = await client.callTool('list_chats', { top: 1 });
    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      status: 'auth_required',
      user_action: { id: 'microsoft.connect_account' },
      setupToolName: 'authenticate_microsoft_account',
    });
    expect(state.refreshCalls).toBe(1);
  });
});
