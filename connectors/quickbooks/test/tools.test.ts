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
  createInvoicesQueryResponse,
  createCustomersQueryResponse,
  createBillsQueryResponse,
  createVendorsQueryResponse,
  createAccountsQueryResponse,
  createEmployeesQueryResponse,
  createReportResponse,
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

describe('query_quickbooks', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('executes a query and returns results', async () => {
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('query_quickbooks', {
      query: "SELECT * FROM Invoice WHERE Balance > '0'",
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.entity).toBe('Invoice');
    expect(json.count).toBeGreaterThan(0);
  });
});

describe('get_quickbooks_entity', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('retrieves a single entity by type and ID', async () => {
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('get_quickbooks_entity', {
      entityType: 'Invoice',
      entityId: '123',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.Invoice).toBeDefined();
  });
});

describe('list_quickbooks_invoices', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists invoices with structured data', async () => {
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('list_quickbooks_invoices', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.invoices)).toBe(true);
    expect(json.count).toBeGreaterThan(0);
  });

  it('filters by status', async () => {
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
    await testClient.callTool('list_quickbooks_invoices', { status: 'unpaid' });
    expect(capturedQuery).toContain("Balance > '0'");
  });
});

describe('list_quickbooks_customers', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists customers', async () => {
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('list_quickbooks_customers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.customers)).toBe(true);
  });
});

describe('create_quickbooks_invoice', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('creates an invoice', async () => {
    // Mutating tools require QB_ALLOW_PROD_WRITES=1 (M3.13 secure-by-default gate).
    vi.stubEnv('QB_ALLOW_PROD_WRITES', '1');
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_invoice', {
      customerId: 'cust-001',
      lines: [{ description: 'Consulting', amount: 1500 }],
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Invoice created.');
  });
});

describe('create_quickbooks_customer', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('creates a customer', async () => {
    // Mutating tools require QB_ALLOW_PROD_WRITES=1 (M3.13 secure-by-default gate).
    vi.stubEnv('QB_ALLOW_PROD_WRITES', '1');
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_customer', {
      displayName: 'New Corp',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Customer created.');
  });
});

describe('list_quickbooks_bills', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists bills', async () => {
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('list_quickbooks_bills', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.bills)).toBe(true);
  });
});

describe('create_quickbooks_bill', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('creates a bill', async () => {
    // Mutating tools require QB_ALLOW_PROD_WRITES=1 (M3.13 secure-by-default gate).
    vi.stubEnv('QB_ALLOW_PROD_WRITES', '1');
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_bill', {
      vendorId: 'vend-001',
      lines: [{ description: 'Office supplies', amount: 250 }],
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Bill created.');
  });
});

describe('list_quickbooks_vendors', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists vendors', async () => {
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('list_quickbooks_vendors', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.vendors)).toBe(true);
  });
});

describe('create_quickbooks_vendor', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('creates a vendor', async () => {
    // Mutating tools require QB_ALLOW_PROD_WRITES=1 (M3.13 secure-by-default gate).
    vi.stubEnv('QB_ALLOW_PROD_WRITES', '1');
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_vendor', {
      displayName: 'New Vendor',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Vendor created.');
  });
});

describe('list_quickbooks_accounts', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists accounts', async () => {
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('list_quickbooks_accounts', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.accounts)).toBe(true);
  });
});

describe('list_quickbooks_employees', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists employees', async () => {
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('list_quickbooks_employees', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.employees)).toBe(true);
  });
});

describe('get_quickbooks_report', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('runs a ProfitAndLoss report over a date range', async () => {
    let capturedUrl = '';
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/reports/:reportName`, ({ request, params }) => {
        capturedUrl = request.url;
        return HttpResponse.json(createReportResponse(params.reportName as string));
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('get_quickbooks_report', {
      report: 'ProfitAndLoss',
      startDate: '2026-01-01',
      endDate: '2026-03-31',
      accountingMethod: 'Accrual',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    const report = json.report as { Header: { ReportName: string } };
    // Report payloads are enveloped wholesale (arbitrary shape).
    expect(report.Header.ReportName).toBe(
      '<untrusted-content source="quickbooks:get_quickbooks_report:ProfitAndLoss">ProfitAndLoss</untrusted-content>',
    );
    expect(capturedUrl).toContain('start_date=2026-01-01');
    expect(capturedUrl).toContain('end_date=2026-03-31');
    expect(capturedUrl).toContain('accounting_method=Accrual');
  });

  it('maps asOfDate to report_date for aging reports', async () => {
    let capturedUrl = '';
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/reports/:reportName`, ({ request, params }) => {
        capturedUrl = request.url;
        return HttpResponse.json(createReportResponse(params.reportName as string));
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('get_quickbooks_report', {
      report: 'AgedReceivables',
      asOfDate: '2026-03-31',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(capturedUrl).toContain('report_date=2026-03-31');
    expect(capturedUrl).not.toContain('start_date');
  });

  it('envelopes report string values as untrusted content', async () => {
    mswServer.use(...createQuickBooksHandlers());
    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('get_quickbooks_report', { report: 'BalanceSheet' });
    const json = result.json as {
      report: { Rows: { Row: Array<{ Rows: { Row: Array<{ ColData: Array<{ value: string }> }> } }> } };
    };
    const cellValue = json.report.Rows.Row[0].Rows.Row[0].ColData[0].value;
    expect(cellValue).toBe(
      '<untrusted-content source="quickbooks:get_quickbooks_report:BalanceSheet">Consulting Revenue</untrusted-content>',
    );
  });

  it('rejects an unknown report name before any outbound request', async () => {
    let outboundRequestCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => {
        outboundRequestCount++;
        return HttpResponse.json(createTokenResponse());
      }),
      http.get(`${PRODUCTION_API_BASE}/reports/:reportName`, () => {
        outboundRequestCount++;
        return HttpResponse.json(createReportResponse());
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('get_quickbooks_report', {
      report: 'NotAReport',
    } as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(outboundRequestCount).toBe(0);
  });

  it('returns a structured error when the API fails', async () => {
    mswServer.use(...createQuickBooksHandlers({ apiErrorStatus: 500 }));
    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('get_quickbooks_report', { report: 'CashFlow' });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('SERVER_ERROR');
  });
});

describe('Malformed input rejected by Zod', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('rejects malformed query_quickbooks input before outbound request', async () => {
    let outboundRequestCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => {
        outboundRequestCount++;
        return HttpResponse.json(createTokenResponse());
      }),
      http.get(`${PRODUCTION_API_BASE}/query`, () => {
        outboundRequestCount++;
        return HttpResponse.json(createInvoicesQueryResponse());
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    // query_quickbooks requires query:string, send number instead
    const result = await testClient.callTool('query_quickbooks', { query: 123 as unknown as string });
    expect(result.isError).toBe(true);
    expect(outboundRequestCount).toBe(0);
  });

  it('rejects malformed create_quickbooks_invoice input', async () => {
    let outboundRequestCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => {
        outboundRequestCount++;
        return HttpResponse.json(createTokenResponse());
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    // Missing required 'lines' field
    const result = await testClient.callTool('create_quickbooks_invoice', {
      customerId: 'cust-001',
    } as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(outboundRequestCount).toBe(0);
  });
});

describe('Configure tool', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('configures credentials when token exchange succeeds (no bridge)', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
    );

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
      clientId: 'new-client-id',
      clientSecret: 'new-client-secret',
      refreshToken: 'new-refresh-token',
      realmId: 'new-realm-id',
      environment: 'sandbox',
    });
    const json = result.json as Record<string, unknown>;
    // Bridge not available → success: false from bridge, but returns error
    // since bridge is required
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe('string');
  });

  it('rejects invalid credentials on token exchange failure', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          { error: 'invalid_grant', error_description: 'Token expired' },
          { status: 400 },
        ),
      ),
    );

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
      clientId: 'bad-id',
      clientSecret: 'bad-secret',
      refreshToken: 'bad-token',
      realmId: 'bad-realm',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('Invalid credentials');
    // Must not contain secrets
    expect(result.text).not.toContain('bad-secret');
    expect(result.text).not.toContain('bad-token');
  });
});

describe('Bridge integration', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns isError when bridge returns 401/403', async () => {
    const bridgePort = 19876;
    const bridgeToken = 'test-bridge-token';

    // Create a temp bridge state file
    const { createTempConfig } = await import('@mindstone/mcp-test-harness');
    const tempConfig = await createTempConfig({
      configDir: 'quickbooks-bridge-test',
    });

    // Write bridge state file
    const fs = await import('fs');
    const path = await import('path');
    const bridgeStatePath = path.join(tempConfig.configPath, 'bridge-state.json');
    fs.writeFileSync(bridgeStatePath, JSON.stringify({ port: bridgePort, token: bridgeToken }));

    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`http://127.0.0.1:${bridgePort}/bundled/quickbooks/configure`, () =>
        HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      ),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: '',
        QUICKBOOKS_CLIENT_SECRET: '',
        QUICKBOOKS_REFRESH_TOKEN: '',
        QUICKBOOKS_REALM_ID: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_quickbooks', {
      clientId: 'new-id',
      clientSecret: 'new-secret',
      refreshToken: 'new-token',
      realmId: 'new-realm',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('unauthorized');

    await tempConfig.cleanup();
  });

  it('succeeds when bridge returns success', async () => {
    const bridgePort = 19877;
    const bridgeToken = 'test-bridge-token';

    const { createTempConfig } = await import('@mindstone/mcp-test-harness');
    const tempConfig = await createTempConfig({
      configDir: 'quickbooks-bridge-test-2',
    });

    const fs = await import('fs');
    const path = await import('path');
    const bridgeStatePath = path.join(tempConfig.configPath, 'bridge-state.json');
    fs.writeFileSync(bridgeStatePath, JSON.stringify({ port: bridgePort, token: bridgeToken }));

    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`http://127.0.0.1:${bridgePort}/bundled/quickbooks/configure`, ({ request }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${bridgeToken}`) {
          return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return HttpResponse.json({ success: true });
      }),
    );

    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: '',
        QUICKBOOKS_CLIENT_SECRET: '',
        QUICKBOOKS_REFRESH_TOKEN: '',
        QUICKBOOKS_REALM_ID: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_quickbooks', {
      clientId: 'new-id',
      clientSecret: 'new-secret',
      refreshToken: 'new-token',
      realmId: 'new-realm',
      environment: 'sandbox',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(String(json.message)).toContain('configured successfully');

    await tempConfig.cleanup();
  });
});

describe('Not configured returns actionable error', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns NOT_CONFIGURED when credentials are missing', async () => {
    testClient = await createTestClient({
      env: {
        QUICKBOOKS_CLIENT_ID: '',
        QUICKBOOKS_CLIENT_SECRET: '',
        QUICKBOOKS_REFRESH_TOKEN: '',
        QUICKBOOKS_REALM_ID: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_quickbooks_invoices', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('NOT_CONFIGURED');
    expect(json.resolution).toBeDefined();
  });
});
