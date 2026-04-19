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
  TOKEN_URL,
  PRODUCTION_API_BASE,
  createTokenResponse,
  createVendorsQueryResponse,
  createCustomersQueryResponse,
  createInvoicesQueryResponse,
  createBillsQueryResponse,
  createAccountsQueryResponse,
} from './fixtures/quickbooks-data.js';

function defaultEnv() {
  return {
    QUICKBOOKS_CLIENT_ID: MOCK_CLIENT_ID,
    QUICKBOOKS_CLIENT_SECRET: MOCK_CLIENT_SECRET,
    QUICKBOOKS_REFRESH_TOKEN: MOCK_REFRESH_TOKEN,
    QUICKBOOKS_REALM_ID: MOCK_REALM_ID,
    QUICKBOOKS_ENVIRONMENT: 'production',
    MCP_HOST_BRIDGE_STATE: '',
  };
}

describe('QBOQL injection prevention — escapeQboql()', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('escapes single quotes in vendor search term', async () => {
    let capturedUrl = '';

    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(createVendorsQueryResponse());
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    await testClient.callTool('list_quickbooks_vendors', {
      searchTerm: "O'Reilly",
    });

    expect(capturedUrl).toBeTruthy();
    // The query parameter is already encoded by encodeURIComponent in client.ts.
    // We check the raw URL for the escaped quote pattern.
    // In the QBOQL: O\'Reilly → encoded as O%5C'Reilly or O%5C%27Reilly
    expect(capturedUrl).toContain('%5C');
  });

  it('escapes backslashes in vendor search term', async () => {
    let capturedUrl = '';

    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(createVendorsQueryResponse());
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    await testClient.callTool('list_quickbooks_vendors', {
      searchTerm: 'back\\slash',
    });

    expect(capturedUrl).toBeTruthy();
    // Double backslash in QBOQL → encoded as %5C%5C
    expect(capturedUrl).toContain('%5C%5C');
  });

  it('escapes QBOQL injection attempt in customer search term', async () => {
    let capturedUrl = '';

    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(createCustomersQueryResponse());
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    await testClient.callTool('list_quickbooks_customers', {
      searchTerm: "' OR 1=1 --",
    });

    expect(capturedUrl).toBeTruthy();
    // The injected single quote should be escaped with backslash in the QBOQL
    // The raw URL should contain %5C (encoded backslash) before the quote
    expect(capturedUrl).toContain('%5C');
    // The original unescaped injection pattern should NOT appear
    expect(capturedUrl).not.toContain("'%25'%20OR%201");
  });

  it('escapes single quotes in account type filter', async () => {
    let capturedUrl = '';

    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(createAccountsQueryResponse());
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    await testClient.callTool('list_quickbooks_accounts', {
      accountType: "Expense' OR '1'='1",
    });

    expect(capturedUrl).toBeTruthy();
    // Single quotes in the injected value should all be escaped with backslash
    expect(capturedUrl).toContain('%5C');
  });
});

describe('QBOQL injection prevention — ID validation', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('rejects malicious vendorId in bill listing', async () => {
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('list_quickbooks_bills', {
      vendorId: "123' OR '1'='1",
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_INPUT');
  });

  it('rejects malicious customerId in invoice listing', async () => {
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('list_quickbooks_invoices', {
      customerId: "123' DROP TABLE Invoice --",
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_INPUT');
  });

  it('accepts valid alphanumeric vendorId', async () => {
    let capturedQuery: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, async ({ request }) => {
        const url = new URL(request.url);
        capturedQuery = decodeURIComponent(url.searchParams.get('query') ?? '');
        return HttpResponse.json(createBillsQueryResponse());
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('list_quickbooks_bills', {
      vendorId: 'vend-001',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(capturedQuery).toContain("VendorRef = 'vend-001'");
  });

  it('accepts valid alphanumeric customerId', async () => {
    let capturedQuery: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, async ({ request }) => {
        const url = new URL(request.url);
        capturedQuery = decodeURIComponent(url.searchParams.get('query') ?? '');
        return HttpResponse.json(createInvoicesQueryResponse());
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('list_quickbooks_invoices', {
      customerId: 'cust-001',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(capturedQuery).toContain("CustomerRef = 'cust-001'");
  });
});

describe('escapeQboql unit tests', () => {
  it('escapes single quotes', async () => {
    vi.resetModules();
    const { escapeQboql } = await import('../src/utils.js');
    expect(escapeQboql("O'Reilly")).toBe("O\\'Reilly");
  });

  it('escapes backslashes', async () => {
    vi.resetModules();
    const { escapeQboql } = await import('../src/utils.js');
    expect(escapeQboql('back\\slash')).toBe('back\\\\slash');
  });

  it('escapes both in combination', async () => {
    vi.resetModules();
    const { escapeQboql } = await import('../src/utils.js');
    expect(escapeQboql("it\\'s")).toBe("it\\\\\\'s");
  });

  it('leaves clean strings unchanged', async () => {
    vi.resetModules();
    const { escapeQboql } = await import('../src/utils.js');
    expect(escapeQboql('hello world')).toBe('hello world');
  });
});
