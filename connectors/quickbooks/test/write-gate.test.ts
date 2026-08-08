/**
 * VAL-QB-101..501 — Production writes run by default (capability-first).
 *
 * All mutating QuickBooks tools (`create_quickbooks_invoice`, `_bill`,
 * `_customer`, `_vendor`, `_estimate`, `update_*`,
 * `send_quickbooks_invoice_email`) execute their write without any
 * environment opt-in: capability is enabled by default and the host's
 * tool-approval layer is the gate. These tests assert each write tool
 * reaches the (mocked) QuickBooks API with no write-gate env var set.
 */

import { describe, it, expect, afterEach } from 'vitest';
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

describe('VAL-QB-101..104 — write tools run by default (no env opt-in)', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
  });

  it('VAL-QB-101 — create_quickbooks_invoice posts upstream once', async () => {
    let postCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`${PRODUCTION_API_BASE}/invoice`, () => {
        postCount++;
        return HttpResponse.json({ Invoice: { Id: 'i-1', DocNumber: '1001' } });
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_invoice', {
      customerId: '123',
      lines: [{ description: 'x', amount: 100 }],
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    const invoice = json.invoice as Record<string, unknown>;
    expect(invoice.Id).toBe('i-1');
    expect(postCount).toBe(1);
  });

  it('VAL-QB-102 — create_quickbooks_bill posts upstream once', async () => {
    let postCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`${PRODUCTION_API_BASE}/bill`, () => {
        postCount++;
        return HttpResponse.json({ Bill: { Id: 'b-1' } });
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_bill', {
      vendorId: 'vend-1',
      lines: [{ description: 'office supplies', amount: 50 }],
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    const bill = json.bill as Record<string, unknown>;
    expect(bill.Id).toBe('b-1');
    expect(postCount).toBe(1);
  });

  it('VAL-QB-103 — create_quickbooks_customer posts upstream once', async () => {
    let postCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`${PRODUCTION_API_BASE}/customer`, () => {
        postCount++;
        return HttpResponse.json({ Customer: { Id: 'c-1', DisplayName: 'X' } });
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_customer', {
      displayName: 'X',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    const customer = json.customer as Record<string, unknown>;
    expect(customer.Id).toBe('c-1');
    expect(postCount).toBe(1);
  });

  it('VAL-QB-104 — create_quickbooks_vendor posts upstream once', async () => {
    let postCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`${PRODUCTION_API_BASE}/vendor`, () => {
        postCount++;
        return HttpResponse.json({ Vendor: { Id: 'v-1', DisplayName: 'Y' } });
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_vendor', {
      displayName: 'Y',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    const vendor = json.vendor as Record<string, unknown>;
    expect(vendor.Id).toBe('v-1');
    expect(postCount).toBe(1);
  });
});

describe('VAL-QB-301 — read-only tools still work', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
  });

  it('list_quickbooks_invoices succeeds', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createInvoicesQueryResponse()),
      ),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('list_quickbooks_invoices', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.invoices)).toBe(true);
  });

  it('list_quickbooks_customers succeeds', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createCustomersQueryResponse()),
      ),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('list_quickbooks_customers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.customers)).toBe(true);
  });

  it('list_quickbooks_bills succeeds', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createBillsQueryResponse()),
      ),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('list_quickbooks_bills', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.bills)).toBe(true);
  });

  it('list_quickbooks_vendors succeeds', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createVendorsQueryResponse()),
      ),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('list_quickbooks_vendors', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.vendors)).toBe(true);
  });

  it('list_quickbooks_accounts succeeds', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createAccountsQueryResponse()),
      ),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('list_quickbooks_accounts', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.accounts)).toBe(true);
  });

  it('list_quickbooks_employees succeeds', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createEmployeesQueryResponse()),
      ),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('list_quickbooks_employees', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.employees)).toBe(true);
  });

  it('query_quickbooks succeeds', async () => {
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.get(`${PRODUCTION_API_BASE}/query`, () =>
        HttpResponse.json(createInvoicesQueryResponse()),
      ),
    );

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('query_quickbooks', {
      query: "SELECT * FROM Invoice WHERE Balance > '0'",
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });

  it('get_quickbooks_entity succeeds', async () => {
    mswServer.use(...createQuickBooksHandlers());

    testClient = await createTestClient({ env: defaultEnv() });
    const result = await testClient.callTool('get_quickbooks_entity', {
      entityType: 'Invoice',
      entityId: '123',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });
});

describe('VAL-QB-302 — every destructiveHint:true tool executes its write by default', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
  });

  it('every tool whose annotation has destructiveHint:true reaches the QuickBooks API', async () => {
    let destructivePostCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      // update_quickbooks_invoice reads the SyncToken first when it is omitted.
      http.get(`${PRODUCTION_API_BASE}/invoice/:id`, () =>
        HttpResponse.json({ Invoice: { Id: 'inv-1', SyncToken: '0' } }),
      ),
      http.post(`${PRODUCTION_API_BASE}/invoice/:invoiceId/send`, ({ params }) => {
        destructivePostCount++;
        return HttpResponse.json({
          Invoice: { Id: params.invoiceId as string, EmailStatus: 'EmailSent' },
        });
      }),
      http.post(`${PRODUCTION_API_BASE}/:entityType`, ({ params }) => {
        destructivePostCount++;
        const entityType = params.entityType as string;
        const key = entityType.charAt(0).toUpperCase() + entityType.slice(1);
        return HttpResponse.json({ [key]: { Id: 'mock-1', SyncToken: '1' } });
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    // Enumerate tools.
    const tools = await testClient.client.listTools();
    const destructive = tools.tools.filter(
      (t) =>
        t.annotations &&
        (t.annotations as { destructiveHint?: boolean }).destructiveHint === true,
    );
    expect(destructive.length).toBeGreaterThanOrEqual(4);

    // Map each known tool to a minimal valid input.
    const minimalInputs: Record<string, Record<string, unknown>> = {
      create_quickbooks_invoice: {
        customerId: '123',
        lines: [{ description: 'x', amount: 1 }],
      },
      create_quickbooks_bill: {
        vendorId: 'v1',
        lines: [{ description: 'x', amount: 1 }],
      },
      create_quickbooks_customer: { displayName: 'X' },
      create_quickbooks_vendor: { displayName: 'Y' },
      create_quickbooks_estimate: {
        customerId: 'c1',
        lines: [{ description: 'x', amount: 1 }],
      },
      send_quickbooks_invoice_email: { invoiceId: 'inv-1' },
      update_quickbooks_invoice: { invoiceId: 'inv-1', memo: 'Net 30' },
      update_quickbooks_customer: { customerId: 'c1', syncToken: '0', email: 'ap@example.com' },
      update_quickbooks_vendor: { vendorId: 'v1', syncToken: '0', email: 'ap@example.com' },
    };

    for (const t of destructive) {
      const input = minimalInputs[t.name];
      // If a future destructive tool is added without an entry here,
      // fail loudly so it does not silently slip through untested.
      expect(
        input,
        `No minimal input mapping for destructive tool '${t.name}'. Add one and assert it executes by default.`,
      ).toBeDefined();

      const result = await testClient.callTool(t.name, input);
      const json = result.json as Record<string, unknown>;
      expect(json.ok, `tool ${t.name} should execute its write by default`).toBe(true);
    }

    expect(destructivePostCount).toBe(destructive.length);
  });
});
