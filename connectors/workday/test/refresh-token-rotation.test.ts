/**
 * Setup must keep the refresh token the provider returned, not the one it was
 * given. Workday can rotate the refresh token on any grant: the response
 * carries a new one and the old one stops working. configure_workday_credentials
 * validates the credentials with a grant, so it has to save and use what that
 * grant returned.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createTempConfig } from '@mindstone/mcp-test-harness';
import * as fs from 'fs';
import * as path from 'path';
import { mswServer } from './helpers/setup.js';
import { createWorkdayHandlers } from './helpers/workday-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import {
  MOCK_HOST,
  MOCK_TENANT,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  TOKEN_URL,
  createTokenResponse,
} from './fixtures/workday-data.js';

const BRIDGE_PORT = 19892;
const BRIDGE_TOKEN = 'test-bridge-token';

/**
 * A token endpoint that rotates: each refresh-token grant with the current
 * token issues a new one and retires the old; a retired token gets
 * invalid_grant. A client-credentials grant gets `clientCredentialsRefresh`
 * as its refresh token, if set.
 */
function rotatingTokenEndpoint(
  initial: string,
  options: { rotate?: boolean; expiresIn?: number; clientCredentialsRefresh?: string } = {},
) {
  const rotate = options.rotate ?? true;
  const expiry = options.expiresIn === undefined ? {} : { expires_in: options.expiresIn };
  let current = initial;
  let issued = 0;
  const grants: Array<{ grantType: string | null; presented: string | null; accepted: boolean }> = [];
  const handler = http.post(TOKEN_URL, async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    const grantType = form.get('grant_type');
    const presented = form.get('refresh_token');
    if (grantType === 'client_credentials') {
      grants.push({ grantType, presented, accepted: true });
      const refresh = options.clientCredentialsRefresh;
      if (refresh) current = refresh;
      return HttpResponse.json(
        createTokenResponse({ ...expiry, ...(refresh ? { refresh_token: refresh } : {}) }),
      );
    }
    const accepted = presented === current;
    grants.push({ grantType, presented, accepted });
    if (!accepted) {
      return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (!rotate) return HttpResponse.json(createTokenResponse(expiry));
    issued += 1;
    current = `rotated-refresh-token-${issued}`;
    return HttpResponse.json(createTokenResponse({ ...expiry, refresh_token: current }));
  });
  return { handler, grants, current: () => current };
}

/** A bridge that records what each route was sent. */
function recordingBridge() {
  const configureBodies: Array<Record<string, unknown>> = [];
  const rotationBodies: Array<Record<string, unknown>> = [];
  const handlers = [
    http.post(`http://127.0.0.1:${BRIDGE_PORT}/bundled/workday/configure`, async ({ request }) => {
      configureBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ success: true });
    }),
    http.post(`http://127.0.0.1:${BRIDGE_PORT}/bundled/workday/update-refresh-token`, async ({ request }) => {
      rotationBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ success: true });
    }),
  ];
  return { handlers, configureBodies, rotationBodies };
}

describe('configure_workday_credentials keeps a rotated refresh token', () => {
  let testClient: McpTestClient | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    testClient = undefined;
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  async function startClient(env: Record<string, string> = {}) {
    const tempConfig = createTempConfig({ prefix: 'workday-rotation-test-' });
    cleanup = tempConfig.cleanup;
    const bridgeStatePath = path.join(tempConfig.configPath, 'bridge-state.json');
    fs.writeFileSync(bridgeStatePath, JSON.stringify({ port: BRIDGE_PORT, token: BRIDGE_TOKEN }));
    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: '',
        WORKDAY_TENANT: '',
        WORKDAY_CLIENT_ID: '',
        WORKDAY_CLIENT_SECRET: '',
        WORKDAY_REFRESH_TOKEN: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
        ...env,
      },
    });
    return testClient;
  }

  const configureArgs = {
    host: MOCK_HOST,
    tenant: MOCK_TENANT,
    client_id: MOCK_CLIENT_ID,
    client_secret: MOCK_CLIENT_SECRET,
    refresh_token: 'typed-refresh-token',
  };

  it('saves the refresh token the validation grant returned', async () => {
    const endpoint = rotatingTokenEndpoint('typed-refresh-token');
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createWorkdayHandlers());
    const client = await startClient();

    const result = await client.callTool('configure_workday_credentials', configureArgs);

    expect((result.json as Record<string, unknown>).ok).toBe(true);
    expect(bridge.configureBodies).toHaveLength(1);
    expect(bridge.configureBodies[0].refreshToken).toBe(endpoint.current());
  });

  it('keeps working after setup without presenting the retired token', async () => {
    const endpoint = rotatingTokenEndpoint('typed-refresh-token');
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createWorkdayHandlers());
    const client = await startClient();

    await client.callTool('configure_workday_credentials', configureArgs);
    const listed = await client.callTool('list_workday_workers', {});

    expect((listed.json as Record<string, unknown>).ok).toBe(true);
    expect(endpoint.grants.every((grant) => grant.accepted)).toBe(true);
  });

  it('saves the typed token when the grant returns none', async () => {
    const endpoint = rotatingTokenEndpoint('typed-refresh-token', { rotate: false });
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createWorkdayHandlers());
    const client = await startClient();

    const result = await client.callTool('configure_workday_credentials', configureArgs);

    expect((result.json as Record<string, unknown>).ok).toBe(true);
    expect(bridge.configureBodies[0].refreshToken).toBe('typed-refresh-token');
  });

  it('client-credentials setup saves no refresh token when none is returned', async () => {
    const endpoint = rotatingTokenEndpoint('unused');
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createWorkdayHandlers());
    const client = await startClient();

    const { refresh_token: _omitted, ...clientCredentialsArgs } = configureArgs;
    const result = await client.callTool('configure_workday_credentials', clientCredentialsArgs);

    expect((result.json as Record<string, unknown>).ok).toBe(true);
    expect(endpoint.grants[0].grantType).toBe('client_credentials');
    expect(bridge.configureBodies[0].refreshToken).toBeUndefined();
  });

  it('client-credentials setup saves a refresh token the grant returned', async () => {
    const endpoint = rotatingTokenEndpoint('unused', { clientCredentialsRefresh: 'issued-refresh-token' });
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createWorkdayHandlers());
    const client = await startClient();

    const { refresh_token: _omitted, ...clientCredentialsArgs } = configureArgs;
    const result = await client.callTool('configure_workday_credentials', clientCredentialsArgs);

    expect((result.json as Record<string, unknown>).ok).toBe(true);
    expect(bridge.configureBodies[0].refreshToken).toBe('issued-refresh-token');
  });

  it('at runtime, each grant presents the latest token and persists the new one', async () => {
    // expires_in 60 leaves no cache window, so every call makes a grant.
    const endpoint = rotatingTokenEndpoint('typed-refresh-token', { expiresIn: 60 });
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createWorkdayHandlers());
    const client = await startClient({
      WORKDAY_HOST: MOCK_HOST,
      WORKDAY_TENANT: MOCK_TENANT,
      WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
      WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      WORKDAY_REFRESH_TOKEN: 'typed-refresh-token',
    });

    for (let i = 0; i < 3; i++) {
      const listed = await client.callTool('list_workday_workers', {});
      expect((listed.json as Record<string, unknown>).ok).toBe(true);
    }

    expect(endpoint.grants).toHaveLength(3);
    expect(endpoint.grants.every((grant) => grant.accepted)).toBe(true);
    await vi.waitFor(() => {
      expect(bridge.rotationBodies.at(-1)?.refreshToken).toBe(endpoint.current());
    });
  });

  it('setup then later refreshes present the rotated token each time', async () => {
    // expires_in 60 leaves no cache window: setup's grant, then one per call.
    const endpoint = rotatingTokenEndpoint('typed-refresh-token', { expiresIn: 60 });
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createWorkdayHandlers());
    const client = await startClient();

    await client.callTool('configure_workday_credentials', configureArgs);
    for (let i = 0; i < 2; i++) {
      const listed = await client.callTool('list_workday_workers', {});
      expect((listed.json as Record<string, unknown>).ok).toBe(true);
    }

    expect(endpoint.grants.map((grant) => grant.presented)).toEqual([
      'typed-refresh-token',
      'rotated-refresh-token-1',
      'rotated-refresh-token-2',
    ]);
    expect(endpoint.grants.every((grant) => grant.accepted)).toBe(true);
  });

  it('setup reuses the access token its grant returned', async () => {
    const endpoint = rotatingTokenEndpoint('typed-refresh-token');
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createWorkdayHandlers());
    const client = await startClient();

    await client.callTool('configure_workday_credentials', configureArgs);
    await client.callTool('list_workday_workers', {});

    expect(endpoint.grants).toHaveLength(1);
  });

  it('setup re-checks DNS before the bearer-token probe', async () => {
    const endpoint = rotatingTokenEndpoint('typed-refresh-token');
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createWorkdayHandlers());
    const client = await startClient();
    // Public for the grant, private afterwards: a rebinding host.
    const { setDnsLookupForTesting } = await import('../src/auth.js');
    let lookups = 0;
    setDnsLookupForTesting(async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? '93.184.216.34' : '10.0.0.5', family: 4 }];
    });

    const result = await client.callTool('configure_workday_credentials', configureArgs);

    expect((result.json as Record<string, unknown>).ok).toBe(false);
    expect(result.text).toContain('non-public');
    expect(bridge.configureBodies).toHaveLength(0);
  });
});
