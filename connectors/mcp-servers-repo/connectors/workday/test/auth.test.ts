import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createWorkdayHandlers } from './helpers/workday-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import {
  MOCK_HOST,
  MOCK_TENANT,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_REFRESH_TOKEN,
  MOCK_ACCESS_TOKEN,
  TOKEN_URL,
  API_BASE,
  createTokenResponse,
} from './fixtures/workday-data.js';

describe('OAuth2 dual grant type', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('uses client_credentials grant when no refresh_token provided', async () => {
    let capturedGrantType: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const body = await request.text();
        const params = new URLSearchParams(body);
        capturedGrantType = params.get('grant_type');
        return HttpResponse.json(createTokenResponse());
      }),
      http.get(`${API_BASE}/workers`, () =>
        HttpResponse.json({ data: [], total: 0 }),
      ),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        WORKDAY_REFRESH_TOKEN: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(capturedGrantType).toBe('client_credentials');
  });

  it('uses refresh_token grant when refresh_token is provided', async () => {
    let capturedGrantType: string | null = null;
    let capturedRefreshToken: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const body = await request.text();
        const params = new URLSearchParams(body);
        capturedGrantType = params.get('grant_type');
        capturedRefreshToken = params.get('refresh_token');
        return HttpResponse.json(createTokenResponse());
      }),
      http.get(`${API_BASE}/workers`, () =>
        HttpResponse.json({ data: [], total: 0 }),
      ),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        WORKDAY_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(capturedGrantType).toBe('refresh_token');
    expect(capturedRefreshToken).toBe(MOCK_REFRESH_TOKEN);
  });

  it('caches token and reuses until expiry', async () => {
    let tokenRequestCount = 0;

    mswServer.use(
      http.post(TOKEN_URL, async () => {
        tokenRequestCount++;
        return HttpResponse.json(createTokenResponse({ expires_in: 3600 }));
      }),
      http.get(`${API_BASE}/workers`, () =>
        HttpResponse.json({ data: [], total: 0 }),
      ),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('list_workday_workers', {});
    await testClient.callTool('list_workday_workers', {});
    await testClient.callTool('list_workday_workers', {});

    // Only one token request should have been made (token cached)
    expect(tokenRequestCount).toBe(1);
  });

  it('failed token exchange produces actionable error', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(
          { error: 'invalid_client', error_description: 'Client authentication failed' },
          { status: 401 },
        ),
      ),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('AUTH_FAILED');
    expect(json.resolution).toBeDefined();
    // Must not contain secrets
    const text = result.text;
    expect(text).not.toContain(MOCK_CLIENT_SECRET);
    expect(text).not.toContain(MOCK_CLIENT_ID);
  });

  it('handles Basic auth header correctly (base64(clientId:clientSecret))', async () => {
    let capturedAuthHeader: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async ({ request }) => {
        capturedAuthHeader = request.headers.get('Authorization');
        return HttpResponse.json(createTokenResponse());
      }),
      http.get(`${API_BASE}/workers`, () =>
        HttpResponse.json({ data: [], total: 0 }),
      ),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('list_workday_workers', {});

    const expectedBasic = 'Basic ' + Buffer.from(`${MOCK_CLIENT_ID}:${MOCK_CLIENT_SECRET}`).toString('base64');
    expect(capturedAuthHeader).toBe(expectedBasic);
  });

  it('sends Bearer token to API endpoints', async () => {
    let capturedApiAuth: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/workers`, async ({ request }) => {
        capturedApiAuth = request.headers.get('Authorization');
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('list_workday_workers', {});

    expect(capturedApiAuth).toBe(`Bearer ${MOCK_ACCESS_TOKEN}`);
  });
});

describe('Network error handling', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns actionable error on network failure', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.error();
      }),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    // No secrets in error output
    expect(result.text).not.toContain(MOCK_CLIENT_SECRET);
  });

  it('returns actionable error on API network failure after token success', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/workers`, () => {
        return HttpResponse.error();
      }),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    // No secrets in error output
    expect(result.text).not.toContain(MOCK_CLIENT_SECRET);
    expect(result.text).not.toContain(MOCK_CLIENT_ID);
  });
});
