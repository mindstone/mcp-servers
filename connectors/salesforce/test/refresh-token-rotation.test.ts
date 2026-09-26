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
function rotatingOrg() {
  let refresh = 'refresh-0';
  let access = 'access-revoked';
  let issued = 0;
  let rotate = true;
  const grants: Array<{ presented: string | null; accepted: boolean }> = [];
  const handlers = [
    http.post(TOKEN_URL, async ({ request }) => {
      const presented = new URLSearchParams(await request.text()).get('refresh_token');
      const accepted = presented === refresh;
      grants.push({ presented, accepted });
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
      return HttpResponse.json({
        sobjects: [{ name: 'Account', label: 'Account', queryable: true, createable: true, updateable: true, custom: false }],
      });
    }),
  ];
  return {
    handlers,
    grants,
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

  it('keeps using the new token when saving it fails', async () => {
    const org = rotatingOrg();
    mswServer.use(...org.handlers);
    const client = await startClient();
    const credentialsDir = path.join(tempConfig!.configPath, 'credentials');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.chmodSync(credentialsDir, 0o500);
    let logged: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const result = await client.callTool('salesforce_list_objects', {});
        expect((result.json as Record<string, unknown>).ok).toBe(true);
        org.revokeAccess();
      }
    } finally {
      logged = consoleSpy.mock.calls.map((call) => call.map(String).join(' '));
      fs.chmodSync(credentialsDir, 0o700);
      consoleSpy.mockRestore();
    }

    expect(org.grants.map((grant) => grant.presented)).toEqual(['refresh-0', 'refresh-1']);
    expect(org.grants.every((grant) => grant.accepted)).toBe(true);
    expect(logged.some((line) => line.includes('Failed to save refreshed token'))).toBe(true);
  });
});
