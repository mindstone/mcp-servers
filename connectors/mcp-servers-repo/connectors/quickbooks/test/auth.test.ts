import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createQuickBooksHandlers } from './helpers/quickbooks-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_REFRESH_TOKEN,
  MOCK_REALM_ID,
  MOCK_ACCESS_TOKEN,
  TOKEN_URL,
  PRODUCTION_API_BASE,
  SANDBOX_API_BASE,
  createTokenResponse,
  createInvoicesQueryResponse,
} from './fixtures/quickbooks-data.js';

describe('OAuth2 refresh token flow', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('uses refresh_token grant type', async () => {
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
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createInvoicesQueryResponse()),
      ),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_quickbooks_invoices', {});
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
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createInvoicesQueryResponse()),
      ),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('list_quickbooks_invoices', {});
    await testClient.callTool('list_quickbooks_invoices', {});
    await testClient.callTool('list_quickbooks_invoices', {});

    // Only one token request should have been made (token cached)
    expect(tokenRequestCount).toBe(1);
  });

  it('rotates refresh token when server returns new one', async () => {
    const ROTATED_REFRESH_TOKEN = 'rotated-refresh-token-new';
    let secondCallRefreshToken: string | null = null;
    let callCount = 0;

    mswServer.use(
      http.post(TOKEN_URL, async ({ request }) => {
        callCount++;
        const body = await request.text();
        const params = new URLSearchParams(body);

        if (callCount === 1) {
          // First call returns a rotated refresh token
          return HttpResponse.json(createTokenResponse({
            refresh_token: ROTATED_REFRESH_TOKEN,
            expires_in: 1, // expire immediately so we force a second call
          }));
        }

        // Second call should use the rotated refresh token
        secondCallRefreshToken = params.get('refresh_token');
        return HttpResponse.json(createTokenResponse({ expires_in: 3600 }));
      }),
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createInvoicesQueryResponse()),
      ),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    // First call: gets rotated token, expires immediately
    await testClient.callTool('list_quickbooks_invoices', {});

    // Wait for the token to expire (expires_in: 1 - 60 means it's already expired)
    // The next call should use the new rotated refresh token
    await testClient.callTool('list_quickbooks_invoices', {});

    expect(callCount).toBe(2);
    expect(secondCallRefreshToken).toBe(ROTATED_REFRESH_TOKEN);
  });

  it('failed token exchange produces actionable error', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(
          { error: 'invalid_grant', error_description: 'Token has been revoked' },
          { status: 400 },
        ),
      ),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_quickbooks_invoices', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('AUTH_FAILED');
    expect(json.resolution).toBeDefined();
    // Must not contain secrets
    const text = result.text;
    expect(text).not.toContain(MOCK_CLIENT_SECRET);
    expect(text).not.toContain(MOCK_CLIENT_ID);
    expect(text).not.toContain(MOCK_REFRESH_TOKEN);
  });

  it('sends Basic auth header to token endpoint (base64(clientId:clientSecret))', async () => {
    let capturedAuthHeader: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async ({ request }) => {
        capturedAuthHeader = request.headers.get('Authorization');
        return HttpResponse.json(createTokenResponse());
      }),
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createInvoicesQueryResponse()),
      ),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('list_quickbooks_invoices', {});

    const expectedBasic = 'Basic ' + Buffer.from(`${MOCK_CLIENT_ID}:${MOCK_CLIENT_SECRET}`).toString('base64');
    expect(capturedAuthHeader).toBe(expectedBasic);
  });

  it('sends Bearer token to API endpoints', async () => {
    let capturedApiAuth: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${PRODUCTION_API_BASE}/query`, async ({ request }) => {
        capturedApiAuth = request.headers.get('Authorization');
        return HttpResponse.json(createInvoicesQueryResponse());
      }),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('list_quickbooks_invoices', {});
    expect(capturedApiAuth).toBe(`Bearer ${MOCK_ACCESS_TOKEN}`);
  });
});

describe('Sandbox vs production switching', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('uses production API host by default', async () => {
    let capturedUrl: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${PRODUCTION_API_BASE}/query`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(createInvoicesQueryResponse());
      }),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('list_quickbooks_invoices', {});
    expect(capturedUrl).toContain('quickbooks.api.intuit.com');
    expect(capturedUrl).not.toContain('sandbox');
  });

  it('uses sandbox API host when QUICKBOOKS_ENVIRONMENT=sandbox', async () => {
    let capturedUrl: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${SANDBOX_API_BASE}/query`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(createInvoicesQueryResponse());
      }),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'sandbox',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('list_quickbooks_invoices', {});
    expect(capturedUrl).toContain('sandbox-quickbooks.api.intuit.com');
  });
});

describe('Network error handling', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns actionable error on network failure during token exchange', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.error();
      }),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_quickbooks_invoices', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    // No secrets in error output
    expect(result.text).not.toContain(MOCK_CLIENT_SECRET);
    expect(result.text).not.toContain(MOCK_REFRESH_TOKEN);
  });

  it('returns actionable error on API 401 after token success', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(
          { Fault: { Error: [{ Message: 'AuthenticationFailed' }] } },
          { status: 401 },
        ),
      ),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_quickbooks_invoices', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('AUTH_FAILED');
    // No secrets
    expect(result.text).not.toContain(MOCK_CLIENT_SECRET);
    expect(result.text).not.toContain(MOCK_CLIENT_ID);
    expect(result.text).not.toContain(MOCK_REFRESH_TOKEN);
  });
});

describe('QUICKBOOKS_ENVIRONMENT validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects invalid QUICKBOOKS_ENVIRONMENT value at module init', async () => {
    vi.stubEnv('QUICKBOOKS_ENVIRONMENT', 'staging');
    vi.stubEnv('QUICKBOOKS_CLIENT_ID', MOCK_CLIENT_ID);
    vi.stubEnv('QUICKBOOKS_CLIENT_SECRET', MOCK_CLIENT_SECRET);
    vi.stubEnv('QUICKBOOKS_REFRESH_TOKEN', MOCK_REFRESH_TOKEN);
    vi.stubEnv('QUICKBOOKS_REALM_ID', MOCK_REALM_ID);
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.resetModules();

    await expect(async () => {
      await import('../../src/server.js');
    }).rejects.toThrow(/Invalid QUICKBOOKS_ENVIRONMENT.*staging.*sandbox.*production/);
  });

  it('rejects empty string QUICKBOOKS_ENVIRONMENT (not silent default)', async () => {
    vi.stubEnv('QUICKBOOKS_ENVIRONMENT', '');
    vi.stubEnv('QUICKBOOKS_CLIENT_ID', MOCK_CLIENT_ID);
    vi.stubEnv('QUICKBOOKS_CLIENT_SECRET', MOCK_CLIENT_SECRET);
    vi.stubEnv('QUICKBOOKS_REFRESH_TOKEN', MOCK_REFRESH_TOKEN);
    vi.stubEnv('QUICKBOOKS_REALM_ID', MOCK_REALM_ID);
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.resetModules();

    await expect(async () => {
      await import('../../src/server.js');
    }).rejects.toThrow(/Invalid QUICKBOOKS_ENVIRONMENT/);
  });

  it('accepts "sandbox" QUICKBOOKS_ENVIRONMENT', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${SANDBOX_API_BASE}/query`, () =>
        HttpResponse.json(createInvoicesQueryResponse()),
      ),
    );

    const testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'sandbox',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_quickbooks_invoices', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    await testClient.close();
  });

  it('accepts "production" QUICKBOOKS_ENVIRONMENT', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createInvoicesQueryResponse()),
      ),
    );

    const testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
        QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
        QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
        QUICKBOOKS_ENVIRONMENT: 'production',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_quickbooks_invoices', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    await testClient.close();
  });
});
