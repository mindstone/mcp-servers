import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const INSTANCE_BASE = 'https://test-instance.service-now.com';

const OAUTH_ENV = {
  SERVICENOW_INSTANCE: 'test-instance',
  SERVICENOW_USERNAME: '',
  SERVICENOW_PASSWORD: '',
  SERVICENOW_CLIENT_ID: 'test-client-id',
  SERVICENOW_CLIENT_SECRET: 'test-client-secret',
  MCP_HOST_BRIDGE_STATE: '',
};

interface OAuthMock {
  tokenRequestCount: () => number;
  tableAuthHeaders: () => string[];
  tokenRequestBodies: () => string[];
}

/**
 * Installs MSW handlers for the OAuth token endpoint and the incident table.
 * The table handler records the Authorization header of every request.
 */
function useOAuthHandlers(options: { expiresIn?: number } = {}): OAuthMock {
  let tokenCount = 0;
  const authHeaders: string[] = [];
  const bodies: string[] = [];

  mswServer.use(
    http.post(`${INSTANCE_BASE}/oauth_token.do`, async ({ request }) => {
      tokenCount++;
      bodies.push(await request.text());
      return HttpResponse.json({
        access_token: `test-access-token-${tokenCount}`,
        token_type: 'Bearer',
        expires_in: options.expiresIn ?? 1800,
      });
    }),
    http.get(`${INSTANCE_BASE}/api/now/table/incident`, ({ request }) => {
      authHeaders.push(request.headers.get('Authorization') || '');
      return HttpResponse.json({ result: [] });
    }),
  );

  return {
    tokenRequestCount: () => tokenCount,
    tableAuthHeaders: () => authHeaders,
    tokenRequestBodies: () => bodies,
  };
}

describe('ServiceNow OAuth 2.0 client credentials', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('uses a Bearer token when only OAuth credentials are configured', async () => {
    const mock = useOAuthHandlers();
    testClient = await createTestClient({ env: OAUTH_ENV });

    const result = await testClient.callTool('list_servicenow_incidents', {});
    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);

    expect(mock.tableAuthHeaders()).toEqual(['Bearer test-access-token-1']);

    // The token request carries the client credentials grant form body.
    const body = mock.tokenRequestBodies()[0];
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=test-client-id');
  });

  it('caches the token across requests', async () => {
    const mock = useOAuthHandlers();
    testClient = await createTestClient({ env: OAUTH_ENV });

    await testClient.callTool('list_servicenow_incidents', {});
    await testClient.callTool('list_servicenow_incidents', {});

    expect(mock.tokenRequestCount()).toBe(1);
    expect(mock.tableAuthHeaders()).toEqual([
      'Bearer test-access-token-1',
      'Bearer test-access-token-1',
    ]);
  });

  it('refetches the token when it has expired', async () => {
    // expires_in: 0 — immediately stale after the refresh margin.
    const mock = useOAuthHandlers({ expiresIn: 0 });
    testClient = await createTestClient({ env: OAUTH_ENV });

    await testClient.callTool('list_servicenow_incidents', {});
    await testClient.callTool('list_servicenow_incidents', {});

    expect(mock.tokenRequestCount()).toBe(2);
    expect(mock.tableAuthHeaders()).toEqual([
      'Bearer test-access-token-1',
      'Bearer test-access-token-2',
    ]);
  });

  it('prefers Basic auth when both methods are configured', async () => {
    const mock = useOAuthHandlers();
    testClient = await createTestClient({
      env: {
        ...OAUTH_ENV,
        SERVICENOW_USERNAME: 'test-user',
        SERVICENOW_PASSWORD: 'test-pass',
      },
    });

    await testClient.callTool('list_servicenow_incidents', {});

    expect(mock.tokenRequestCount()).toBe(0);
    expect(mock.tableAuthHeaders()).toEqual([
      'Basic ' + Buffer.from('test-user:test-pass').toString('base64'),
    ]);
  });

  it('returns AUTH_FAILED without leaking the client secret when the token endpoint rejects', async () => {
    mswServer.use(
      http.post(`${INSTANCE_BASE}/oauth_token.do`, () =>
        HttpResponse.json(
          { error: 'invalid_client', error_description: 'bad credentials' },
          { status: 401 },
        ),
      ),
    );
    testClient = await createTestClient({ env: OAUTH_ENV });

    const result = await testClient.callTool('list_servicenow_incidents', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('AUTH_FAILED');
    expect(result.text).not.toContain('test-client-secret');
    // The upstream error body is not echoed verbatim.
    expect(result.text).not.toContain('bad credentials');
  });

  it('returns an error when the token response is malformed', async () => {
    mswServer.use(
      http.post(`${INSTANCE_BASE}/oauth_token.do`, () =>
        HttpResponse.json({ unexpected: 'shape' }),
      ),
    );
    testClient = await createTestClient({ env: OAUTH_ENV });

    const result = await testClient.callTool('list_servicenow_incidents', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('API_ERROR');
    expect(result.text).not.toContain('test-client-secret');
  });

  it('clears the cached token after a 401 so a retry refetches', async () => {
    let tableCalls = 0;
    const mock = useOAuthHandlers();
    mswServer.use(
      http.get(`${INSTANCE_BASE}/api/now/table/incident`, ({ request }) => {
        tableCalls++;
        mock.tableAuthHeaders().push(request.headers.get('Authorization') || '');
        // Reject the first token, accept the second.
        if (tableCalls === 1) {
          return HttpResponse.json(
            { error: { message: 'User Not Authenticated' } },
            { status: 401 },
          );
        }
        return HttpResponse.json({ result: [] });
      }),
    );
    testClient = await createTestClient({ env: OAUTH_ENV });

    const first = await testClient.callTool('list_servicenow_incidents', {});
    expect(first.isError).toBe(true);

    const second = await testClient.callTool('list_servicenow_incidents', {});
    const json = second.json as { ok: boolean };
    expect(json.ok).toBe(true);

    // First call used token 1; after the 401 the cache was cleared, so the
    // retry fetched token 2.
    expect(mock.tokenRequestCount()).toBe(2);
    expect(mock.tableAuthHeaders()).toEqual([
      'Bearer test-access-token-1',
      'Bearer test-access-token-2',
    ]);
  });
});
