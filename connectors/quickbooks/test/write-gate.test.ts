/**
 * VAL-QB-101..501 — Secure-by-default write gate.
 *
 * All mutating QuickBooks tools (`create_quickbooks_invoice`, `_bill`,
 * `_customer`, `_vendor`) MUST refuse to execute unless the host has
 * explicitly set `QB_ALLOW_PROD_WRITES=1`. The error message must
 * reference the env var by name and explain the rationale, and the
 * upstream QuickBooks API must NOT be hit (msw handler invocation count
 * must be 0).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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

const REASON_PHRASE_RE = /safety|production|destructive|guard|secure-by-default|prevent.*accident/i;

describe('VAL-QB-101..106 — gate closed by default (env unset / wrong value)', () => {
  let testClient: McpTestClient;

  beforeEach(() => {
    // Make sure the env var is unset for the negative tests.
    vi.stubEnv('QB_ALLOW_PROD_WRITES', '');
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('VAL-QB-101 — env unset: create_quickbooks_invoice refuses without hitting upstream', async () => {
    let postCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`${PRODUCTION_API_BASE}/invoice`, () => {
        postCount++;
        return HttpResponse.json({ Invoice: { Id: 'should-not-happen' } });
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_invoice', {
      customerId: '123',
      lines: [{ description: 'x', amount: 100 }],
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('QB_ALLOW_PROD_WRITES');
    expect(String(json.error)).toMatch(REASON_PHRASE_RE);
    expect(postCount).toBe(0);
  });

  it('VAL-QB-102 — env unset: create_quickbooks_bill refuses without hitting upstream', async () => {
    let postCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`${PRODUCTION_API_BASE}/bill`, () => {
        postCount++;
        return HttpResponse.json({ Bill: { Id: 'should-not-happen' } });
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_bill', {
      vendorId: 'vend-1',
      lines: [{ description: 'office supplies', amount: 50 }],
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('QB_ALLOW_PROD_WRITES');
    expect(String(json.error)).toMatch(REASON_PHRASE_RE);
    expect(postCount).toBe(0);
  });

  it('VAL-QB-103 — env unset: create_quickbooks_customer refuses without hitting upstream', async () => {
    let postCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`${PRODUCTION_API_BASE}/customer`, () => {
        postCount++;
        return HttpResponse.json({ Customer: { Id: 'should-not-happen' } });
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_customer', {
      displayName: 'Acme Corp',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('QB_ALLOW_PROD_WRITES');
    expect(String(json.error)).toMatch(REASON_PHRASE_RE);
    expect(postCount).toBe(0);
  });

  it('VAL-QB-104 — env unset: create_quickbooks_vendor refuses without hitting upstream', async () => {
    let postCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`${PRODUCTION_API_BASE}/vendor`, () => {
        postCount++;
        return HttpResponse.json({ Vendor: { Id: 'should-not-happen' } });
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_vendor', {
      displayName: 'New Vendor',
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('QB_ALLOW_PROD_WRITES');
    expect(String(json.error)).toMatch(REASON_PHRASE_RE);
    expect(postCount).toBe(0);
  });

  it('VAL-QB-105 — empty-string env value also refuses', async () => {
    // Stub explicitly to '' (already done in beforeEach).
    let postCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`${PRODUCTION_API_BASE}/invoice`, () => {
        postCount++;
        return HttpResponse.json({ Invoice: { Id: 'should-not-happen' } });
      }),
    );

    testClient = await createTestClient({ env: defaultEnv() });

    const result = await testClient.callTool('create_quickbooks_invoice', {
      customerId: '123',
      lines: [{ description: 'x', amount: 100 }],
    });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('QB_ALLOW_PROD_WRITES');
    expect(postCount).toBe(0);
  });

  it.each([['true'], ['yes'], ['0'], [' 1 '], ['TRUE']])(
    'VAL-QB-106 — wrong env value %j keeps the gate closed',
    async (badValue) => {
      vi.stubEnv('QB_ALLOW_PROD_WRITES', badValue);

      let postCount = 0;
      mswServer.use(
        http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
        http.post(`${PRODUCTION_API_BASE}/invoice`, () => {
          postCount++;
          return HttpResponse.json({ Invoice: { Id: 'should-not-happen' } });
        }),
      );

      testClient = await createTestClient({ env: defaultEnv() });

      const result = await testClient.callTool('create_quickbooks_invoice', {
        customerId: '123',
        lines: [{ description: 'x', amount: 100 }],
      });
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(String(json.error)).toContain('QB_ALLOW_PROD_WRITES');
      expect(postCount).toBe(0);
    },
  );
});

describe('VAL-QB-201..204 — gate open with QB_ALLOW_PROD_WRITES=1', () => {
  let testClient: McpTestClient;

  beforeEach(() => {
    vi.stubEnv('QB_ALLOW_PROD_WRITES', '1');
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('VAL-QB-201 — create_quickbooks_invoice succeeds and posts upstream once', async () => {
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

  it('VAL-QB-202 — create_quickbooks_bill succeeds and posts upstream once', async () => {
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

  it('VAL-QB-203 — create_quickbooks_customer succeeds and posts upstream once', async () => {
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

  it('VAL-QB-204 — create_quickbooks_vendor succeeds and posts upstream once', async () => {
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

describe('VAL-QB-301 — read-only tools unaffected by gate', () => {
  let testClient: McpTestClient;

  beforeEach(() => {
    vi.stubEnv('QB_ALLOW_PROD_WRITES', '');
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('list_quickbooks_invoices succeeds without QB_ALLOW_PROD_WRITES', async () => {
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

  it('list_quickbooks_customers succeeds without QB_ALLOW_PROD_WRITES', async () => {
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

  it('list_quickbooks_bills succeeds without QB_ALLOW_PROD_WRITES', async () => {
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

  it('list_quickbooks_vendors succeeds without QB_ALLOW_PROD_WRITES', async () => {
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

  it('list_quickbooks_accounts succeeds without QB_ALLOW_PROD_WRITES', async () => {
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

  it('list_quickbooks_employees succeeds without QB_ALLOW_PROD_WRITES', async () => {
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

  it('query_quickbooks succeeds without QB_ALLOW_PROD_WRITES', async () => {
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

  it('get_quickbooks_entity succeeds without QB_ALLOW_PROD_WRITES', async () => {
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

describe('VAL-QB-302 — every destructiveHint:true tool is gated', () => {
  let testClient: McpTestClient;

  beforeEach(() => {
    vi.stubEnv('QB_ALLOW_PROD_WRITES', '');
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('every tool whose annotation has destructiveHint:true returns the QB_ALLOW_PROD_WRITES gate error', async () => {
    // Set up handlers for both query (non-destructive) and POST (would-be destructive) so any
    // accidental upstream call would be observable. We assert no destructive POST is made.
    let destructivePostCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`${PRODUCTION_API_BASE}/:entityType`, () => {
        destructivePostCount++;
        return HttpResponse.json({});
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
    };

    for (const t of destructive) {
      const input = minimalInputs[t.name];
      // The contract calls out that mutating tools = create_invoice/_bill/_customer/_vendor
      // (and any others). If a future destructive tool is added without an entry here,
      // fail loudly so it does not silently slip past the gate.
      expect(
        input,
        `No minimal input mapping for destructive tool '${t.name}'. Add one and ensure the gate covers it.`,
      ).toBeDefined();

      const result = await testClient.callTool(t.name, input);
      const json = result.json as Record<string, unknown>;
      expect(json.ok, `tool ${t.name} should be gated`).toBe(false);
      expect(
        String(json.error),
        `tool ${t.name} error should mention QB_ALLOW_PROD_WRITES`,
      ).toContain('QB_ALLOW_PROD_WRITES');
    }

    expect(destructivePostCount).toBe(0);
  });
});
