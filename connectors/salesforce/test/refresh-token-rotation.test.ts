/**
 * An org can turn on refresh-token rotation: each refresh then returns a new
 * refresh token and retires the old one. jsforce hands the new one to the
 * 'refresh' event but keeps presenting the old one itself, so the connector
 * has to take it up — in the live connection and in the saved token file.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_INSTANCE_URL } from './helpers/salesforce-mock-api.js';

const ACCOUNT_ID = 'acct-rotation';
const TOKEN_URL = 'https://login.salesforce.com/services/oauth2/token';

/**
 * A Salesforce org with rotation on. The token endpoint accepts only the
 * current refresh token and replaces it; the API accepts only the current
 * access token. revokeAccess() forces the next API call to refresh.
 */
function rotatingOrg(beforeTokenResponse?: () => Promise<void>) {
  let refresh = 'refresh-0';
  let access = 'access-revoked';
  let issued = 0;
  let rotate = true;
  let served = 0;
  const grants: Array<{ presented: string | null; accepted: boolean }> = [];
  const handlers = [
    http.post(TOKEN_URL, async ({ request }) => {
      const presented = new URLSearchParams(await request.text()).get('refresh_token');
      const accepted = presented === refresh;
      grants.push({ presented, accepted });
      await beforeTokenResponse?.();
      if (!accepted) {
        return HttpResponse.json(
          { error: 'invalid_grant', error_description: 'expired access/refresh token' },
          { status: 400 },
        );
      }
      issued += 1;
      if (rotate) refresh = `refresh-${issued}`;
      access = `access-${issued}`;
      return HttpResponse.json({
        access_token: access,
        ...(rotate ? { refresh_token: refresh } : {}),
        instance_url: MOCK_INSTANCE_URL,
        issued_at: String(Date.now()),
        id: 'https://login.salesforce.com/id/00D000000000000/005000000000000',
      });
    }),
    http.get('*/services/data/*/sobjects', ({ request }) => {
      if (request.headers.get('authorization') !== `Bearer ${access}`) {
        return HttpResponse.json(
          [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }],
          { status: 401 },
        );
      }
      served += 1;
      return HttpResponse.json({
        sobjects: [{ name: 'Account', label: 'Account', queryable: true, createable: true, updateable: true, custom: false }],
      });
    }),
  ];
  return {
    handlers,
    grants,
    served: () => served,
    currentRefresh: () => refresh,
    revokeAccess: () => {
      access = 'access-revoked';
    },
    /** From now on, refreshes return no refresh token (the current one stays valid). */
    stopRotating: () => {
      rotate = false;
    },
  };
}

describe('Salesforce keeps a rotated refresh token', () => {
  let testClient: McpTestClient | undefined;
  let tempConfig: TempConfigResult | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    testClient = undefined;
    tempConfig?.cleanup();
    tempConfig = undefined;
    vi.unstubAllEnvs();
  });

  async function startClient() {
    tempConfig = createTempConfig({
      prefix: 'salesforce-rotation-test-',
      accounts: [{ id: ACCOUNT_ID, username: 'jane@example.com', connected_at: new Date().toISOString() }],
      credentials: [{
        filename: `${ACCOUNT_ID}.token.json`,
        data: {
          access_token: 'access-stale',
          refresh_token: 'refresh-0',
          instance_url: MOCK_INSTANCE_URL,
          login_url: 'https://login.salesforce.com',
          expires_at: Date.now() + 3600_000,
          username: 'jane@example.com',
        },
      }],
    });
    testClient = await createTestClient({
      env: {
        MCP_HOST_BRIDGE_STATE: '',
        SALESFORCE_CLIENT_ID: 'client-id',
        SALESFORCE_CLIENT_SECRET: 'client-secret',
        SALESFORCE_CONFIG_DIR: tempConfig.configPath,
      },
    });
    return testClient;
  }

  function savedRefreshToken(): unknown {
    const tokenPath = path.join(tempConfig!.configPath, 'credentials', `${ACCOUNT_ID}.token.json`);
    return JSON.parse(fs.readFileSync(tokenPath, 'utf-8')).refresh_token;
  }

  it.each(['SESSION_EXPIRED', 'TOKEN_SAVE_FAILED'])('returns %s to both callers sharing a failed refresh', async (code) => {
    let tokenRequested!: () => void;
    const tokenRequest = new Promise<void>((resolve) => { tokenRequested = resolve; });
    let releaseToken!: () => void;
    const tokenResponse = new Promise<void>((resolve) => { releaseToken = resolve; });
    const org = rotatingOrg(async () => {
      tokenRequested();
      await tokenResponse;
    });
    mswServer.use(...org.handlers);
    const client = await startClient();
    if (code === 'SESSION_EXPIRED') {
      const tokenPath = path.join(tempConfig!.configPath, 'credentials', `${ACCOUNT_ID}.token.json`);
      const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      fs.writeFileSync(tokenPath, JSON.stringify({ ...token, refresh_token: 'refresh-retired' }));
    }
    const { getConnection } = await import('../src/client.js');
    const connection = await getConnection();
    const delegate = connection._refreshDelegate!;
    let callerWaiting!: () => void;
    const waitingCaller = new Promise<void>((resolve) => { callerWaiting = resolve; });
    const waitRefresh = delegate.waitRefresh.bind(delegate);
    const waitSpy = vi.spyOn(delegate, 'waitRefresh').mockImplementation(() => {
      callerWaiting();
      return waitRefresh();
    });
    const credentialsDir = path.join(tempConfig!.configPath, 'credentials');
    if (code === 'TOKEN_SAVE_FAILED') fs.chmodSync(credentialsDir, 0o500);
    try {
      const first = client.callTool('salesforce_list_objects', {});
      await tokenRequest;
      const second = client.callTool('salesforce_list_objects', {});
      await waitingCaller;
      releaseToken();
      const results = await Promise.all([first, second]);

      expect(org.served()).toBe(0);
      expect(results.map((result) => result.json)).toMatchObject([
        { ok: false, code }, { ok: false, code },
      ]);
    } finally {
      releaseToken();
      fs.chmodSync(credentialsDir, 0o700);
      waitSpy.mockRestore();
    }
  });

  it('asks to reconnect after a refused refresh and reloads the reconnected token file', async () => {
    const org = rotatingOrg();
    mswServer.use(...org.handlers);
    const client = await startClient();
    const tokenPath = path.join(tempConfig!.configPath, 'credentials', `${ACCOUNT_ID}.token.json`);
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    fs.writeFileSync(tokenPath, JSON.stringify({ ...token, refresh_token: 'refresh-retired' }));
    const before = fs.readFileSync(tokenPath, 'utf-8');

    const refused = await client.callTool('salesforce_list_objects', {});

    expect(refused.json).toMatchObject({
      ok: false, code: 'SESSION_EXPIRED', resolution: 'Call salesforce_connect_account to re-connect.',
    });
    expect(fs.readFileSync(tokenPath, 'utf-8')).toBe(before);
    fs.writeFileSync(tokenPath, JSON.stringify({ ...token, refresh_token: org.currentRefresh() }));
    const reconnected = await client.callTool('salesforce_list_objects', {});
    expect(reconnected.json.ok).toBe(true);
    expect(org.grants).toEqual([
      { presented: 'refresh-retired', accepted: false },
      { presented: 'refresh-0', accepted: true },
    ]);
  });

  it.each(['network', 'invalid_client', 'rate_limit_exceeded', 'ERROR_HTTP_503'])('keeps the connection and token file after a token endpoint %s failure', async (failure) => {
    const org = rotatingOrg();
    mswServer.use(...org.handlers);
    const client = await startClient();
    const tokenPath = path.join(tempConfig!.configPath, 'credentials', `${ACCOUNT_ID}.token.json`);
    const before = fs.readFileSync(tokenPath, 'utf-8');
    const { getConnection } = await import('../src/client.js');
    const connection = await getConnection();
    mswServer.use(http.post(TOKEN_URL, () => failure === 'network'
      ? HttpResponse.error()
      : failure === 'ERROR_HTTP_503'
        ? new HttpResponse('Service unavailable', { status: 503 })
        : HttpResponse.json({ error: failure, error_description: failure }, { status: 400 })));

    const failed = await client.callTool('salesforce_list_objects', {});

    expect(failed.json.code).toBe('INTERNAL_ERROR');
    expect(fs.readFileSync(tokenPath, 'utf-8')).toBe(before);
    expect(await getConnection()).toBe(connection);
    mswServer.use(...org.handlers);
    expect((await client.callTool('salesforce_list_objects', {})).json.ok).toBe(true);
    expect(org.grants).toEqual([{ presented: 'refresh-0', accepted: true }]);
  });

  it('saves the refresh token a refresh returned', async () => {
    const org = rotatingOrg();
    mswServer.use(...org.handlers);
    const client = await startClient();

    const result = await client.callTool('salesforce_list_objects', {});

    expect((result.json as Record<string, unknown>).ok).toBe(true);
    await vi.waitFor(() => expect(savedRefreshToken()).toBe(org.currentRefresh()));
  });

  it('presents the latest refresh token on the next refresh', async () => {
    const org = rotatingOrg();
    mswServer.use(...org.handlers);
    const client = await startClient();

    for (let i = 0; i < 3; i++) {
      const result = await client.callTool('salesforce_list_objects', {});
      expect((result.json as Record<string, unknown>).ok).toBe(true);
      org.revokeAccess();
    }

    expect(org.grants).toHaveLength(3);
    expect(org.grants.every((grant) => grant.accepted)).toBe(true);
    await vi.waitFor(() => expect(savedRefreshToken()).toBe(org.currentRefresh()));
  });

  it('keeps the latest token when a later refresh returns none', async () => {
    const org = rotatingOrg();
    mswServer.use(...org.handlers);
    const client = await startClient();

    await client.callTool('salesforce_list_objects', {});
    org.revokeAccess();
    org.stopRotating();
    await client.callTool('salesforce_list_objects', {});

    expect(org.grants.map((grant) => grant.presented)).toEqual(['refresh-0', 'refresh-1']);
    expect(org.grants.every((grant) => grant.accepted)).toBe(true);
    await vi.waitFor(() => expect(savedRefreshToken()).toBe('refresh-1'));
  });

  it('saves a pending token on the next call without another refresh', async () => {
    const org = rotatingOrg();
    mswServer.use(...org.handlers);
    const client = await startClient();
    const credentialsDir = path.join(tempConfig!.configPath, 'credentials');
    fs.chmodSync(credentialsDir, 0o500);
    try {
      expect((await client.callTool('salesforce_list_objects', {})).json.code).toBe('TOKEN_SAVE_FAILED');
    } finally {
      fs.chmodSync(credentialsDir, 0o700);
    }
    expect(savedRefreshToken()).toBe('refresh-0');

    expect((await client.callTool('salesforce_list_objects', {})).json.ok).toBe(true);

    expect(org.grants).toEqual([{ presented: 'refresh-0', accepted: true }]);
    expect(savedRefreshToken()).toBe('refresh-1');
  });

  it('reports a failed save without running the request and logs another failed save while allowing a retry', async () => {
    const org = rotatingOrg();
    mswServer.use(...org.handlers);
    const client = await startClient();
    const credentialsDir = path.join(tempConfig!.configPath, 'credentials');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.chmodSync(credentialsDir, 0o500);
    let logged: string[] = [];
    try {
      const failed = await client.callTool('salesforce_list_objects', {});
      expect(failed.json).toMatchObject({ ok: false, code: 'TOKEN_SAVE_FAILED' });
      expect(org.served()).toBe(0);
      const retried = await client.callTool('salesforce_list_objects', {});
      expect((retried.json as Record<string, unknown>).ok).toBe(true);
      expect(org.served()).toBe(1);
    } finally {
      logged = consoleSpy.mock.calls.map((call) => call.map(String).join(' '));
      fs.chmodSync(credentialsDir, 0o700);
      consoleSpy.mockRestore();
    }

    org.revokeAccess();
    const later = await client.callTool('salesforce_list_objects', {});
    expect((later.json as Record<string, unknown>).ok).toBe(true);
    expect(org.served()).toBe(2);
    expect(org.grants.map((grant) => grant.presented)).toEqual(['refresh-0', 'refresh-1']);
    expect(org.grants.every((grant) => grant.accepted)).toBe(true);
    expect(logged.some((line) => line.includes('Failed to save refreshed token'))).toBe(true);
    expect(logged).toContain(`[Salesforce MCP] Still could not save the refreshed token for account ${ACCOUNT_ID}`);
    await vi.waitFor(() => expect(savedRefreshToken()).toBe('refresh-2'));
  });
});
