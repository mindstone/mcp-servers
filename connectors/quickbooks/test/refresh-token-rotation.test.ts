/**
 * Setup must keep the refresh token the provider returned, not the one it was
 * given. Intuit can rotate the refresh token on any grant: the response carries
 * a new one and the old one stops working. configure_quickbooks validates the
 * credentials with a grant, so it has to save and use what that grant returned.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createTempConfig } from '@mindstone/mcp-test-harness';
import * as fs from 'fs';
import * as path from 'path';
import { mswServer } from './helpers/setup.js';
import { createQuickBooksHandlers } from './helpers/quickbooks-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_REALM_ID, TOKEN_URL, createTokenResponse } from './fixtures/quickbooks-data.js';

const BRIDGE_PORT = 19891;
const BRIDGE_TOKEN = 'test-bridge-token';

/**
 * A token endpoint that rotates: each grant with the current refresh token
 * issues a new one and retires the old; a retired token gets invalid_grant.
 */
function rotatingTokenEndpoint(
  initial: string,
  options: { rotate?: boolean; expiresIn?: number } = {},
) {
  const rotate = options.rotate ?? true;
  const expiry = options.expiresIn === undefined ? {} : { expires_in: options.expiresIn };
  let current = initial;
  let issued = 0;
  const grants: Array<{ presented: string | null; accepted: boolean }> = [];
  const handler = http.post(TOKEN_URL, async ({ request }) => {
    const presented = new URLSearchParams(await request.text()).get('refresh_token');
    const accepted = presented === current;
    grants.push({ presented, accepted });
    if (!accepted) {
      return HttpResponse.json(
        { error: 'invalid_grant', error_description: 'Token invalid' },
        { status: 400 },
      );
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
    http.post(`http://127.0.0.1:${BRIDGE_PORT}/bundled/quickbooks/configure`, async ({ request }) => {
      configureBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ success: true });
    }),
    http.post(`http://127.0.0.1:${BRIDGE_PORT}/bundled/quickbooks/update-refresh-token`, async ({ request }) => {
      rotationBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ success: true });
    }),
  ];
  return { handlers, configureBodies, rotationBodies };
}

describe('configure_quickbooks keeps a rotated refresh token', () => {
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
    const tempConfig = createTempConfig({ prefix: 'quickbooks-rotation-test-' });
    cleanup = tempConfig.cleanup;
    const bridgeStatePath = path.join(tempConfig.configPath, 'bridge-state.json');
    fs.writeFileSync(bridgeStatePath, JSON.stringify({ port: BRIDGE_PORT, token: BRIDGE_TOKEN }));
    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: '',
        QUICKBOOKS_CLIENT_SECRET: '',
        QUICKBOOKS_REFRESH_TOKEN: '',
        QUICKBOOKS_REALM_ID: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
        ...env,
      },
    });
    return testClient;
  }

  const configureArgs = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'typed-refresh-token',
    realmId: MOCK_REALM_ID,
    environment: 'production',
  };

  it('saves the refresh token the validation grant returned', async () => {
    const endpoint = rotatingTokenEndpoint('typed-refresh-token');
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers);
    const client = await startClient();

    const result = await client.callTool('configure_quickbooks', configureArgs);

    expect((result.json as Record<string, unknown>).ok).toBe(true);
    expect(bridge.configureBodies).toHaveLength(1);
    expect(bridge.configureBodies[0].refreshToken).toBe(endpoint.current());
  });

  it('keeps working after setup without presenting the retired token', async () => {
    const endpoint = rotatingTokenEndpoint('typed-refresh-token');
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createQuickBooksHandlers());
    const client = await startClient();

    await client.callTool('configure_quickbooks', configureArgs);
    const listed = await client.callTool('list_quickbooks_customers', {});

    expect((listed.json as Record<string, unknown>).ok).toBe(true);
    expect(endpoint.grants.every((grant) => grant.accepted)).toBe(true);
  });

  it('saves the typed token when the grant returns none', async () => {
    const endpoint = rotatingTokenEndpoint('typed-refresh-token', { rotate: false });
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers);
    const client = await startClient();

    const result = await client.callTool('configure_quickbooks', configureArgs);

    expect((result.json as Record<string, unknown>).ok).toBe(true);
    expect(bridge.configureBodies[0].refreshToken).toBe('typed-refresh-token');
  });

  it('at runtime, each grant presents the latest token and persists the new one', async () => {
    // expires_in 60 leaves no cache window, so every call makes a grant.
    const endpoint = rotatingTokenEndpoint('typed-refresh-token', { expiresIn: 60 });
    const bridge = recordingBridge();
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createQuickBooksHandlers());
    const client = await startClient({
      QUICKBOOKS_CLIENT_ID: 'client-id',
      QUICKBOOKS_CLIENT_SECRET: 'client-secret',
      QUICKBOOKS_REFRESH_TOKEN: 'typed-refresh-token',
      QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
    });

    for (let i = 0; i < 3; i++) {
      const listed = await client.callTool('list_quickbooks_customers', {});
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
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createQuickBooksHandlers());
    const client = await startClient();

    await client.callTool('configure_quickbooks', configureArgs);
    for (let i = 0; i < 2; i++) {
      const listed = await client.callTool('list_quickbooks_customers', {});
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
    mswServer.use(endpoint.handler, ...bridge.handlers, ...createQuickBooksHandlers());
    const client = await startClient();

    await client.callTool('configure_quickbooks', configureArgs);
    await client.callTool('list_quickbooks_customers', {});

    expect(endpoint.grants).toHaveLength(1);
  });
});

describe('a failed token grant shows only bounded OAuth text', () => {
  let testClient: McpTestClient | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    testClient = undefined;
    vi.unstubAllEnvs();
  });

  // A diagnostic body with neither error_description nor a well-formed error
  // code, reflecting the credentials just sent.
  const reflectingEndpoint = http.post(TOKEN_URL, () =>
    HttpResponse.json(
      { diagnostics: { echoed_secret: 'client-secret', echoed_token: 'typed-refresh-token' } },
      { status: 400 },
    ),
  );

  it('setup does not forward an arbitrary error body', async () => {
    mswServer.use(reflectingEndpoint);
    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: '',
        QUICKBOOKS_CLIENT_SECRET: '',
        QUICKBOOKS_REFRESH_TOKEN: '',
        QUICKBOOKS_REALM_ID: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_quickbooks', {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'typed-refresh-token',
      realmId: MOCK_REALM_ID,
    });

    expect((result.json as Record<string, unknown>).ok).toBe(false);
    expect(result.text).toContain('HTTP 400');
    expect(result.text).not.toContain('echoed');
    expect(result.text).not.toContain('client-secret');
    expect(result.text).not.toContain('typed-refresh-token');
  });

  it('a runtime grant does not forward an arbitrary error body', async () => {
    mswServer.use(reflectingEndpoint);
    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: 'client-id',
        QUICKBOOKS_CLIENT_SECRET: 'client-secret',
        QUICKBOOKS_REFRESH_TOKEN: 'typed-refresh-token',
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_quickbooks_customers', {});

    expect((result.json as Record<string, unknown>).ok).toBe(false);
    expect(result.text).not.toContain('echoed');
    expect(result.text).not.toContain('client-secret');
    expect(result.text).not.toContain('typed-refresh-token');
  });

  it('keeps a well-formed OAuth error code', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 })),
    );
    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: 'client-id',
        QUICKBOOKS_CLIENT_SECRET: 'client-secret',
        QUICKBOOKS_REFRESH_TOKEN: 'typed-refresh-token',
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_quickbooks_customers', {});

    expect(result.text).toContain('invalid_grant');
  });
});
