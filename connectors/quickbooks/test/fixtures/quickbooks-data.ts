/**
 * Test data factories for QuickBooks Online MCP connector tests.
 */

export const MOCK_CLIENT_ID = 'test-client-id';
export const MOCK_CLIENT_SECRET = 'test-client-secret';
export const MOCK_REFRESH_TOKEN = 'test-refresh-token-abc123';
export const MOCK_REALM_ID = '123456789';
export const MOCK_ACCESS_TOKEN = 'test-access-token-xyz789';

/** Minimal valid PDF header bytes for download tests. */
export const MOCK_PDF_BYTES = new TextEncoder().encode('%PDF-1.4 mock invoice pdf');

export const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const SANDBOX_API_BASE = `https://sandbox-quickbooks.api.intuit.com/v3/company/${MOCK_REALM_ID}`;
export const PRODUCTION_API_BASE = `https://quickbooks.api.intuit.com/v3/company/${MOCK_REALM_ID}`;

export function createTokenResponse(overrides: Partial<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> = {}) {
  return {
    access_token: MOCK_ACCESS_TOKEN,
    token_type: 'Bearer',
    expires_in: 3600,
    ...overrides,
  };
}

export function createInvoice(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'inv-001',
    DocNumber: '1001',
    TxnDate: '2024-01-15',
    DueDate: '2024-02-15',
    Balance: 1500.00,
    TotalAmt: 1500.00,
    CustomerRef: { value: 'cust-001', name: 'Acme Corp' },
    Line: [
      {
        Amount: 1500.00,
        DetailType: 'SalesItemLineDetail',
        Description: 'Consulting services',
        SalesItemLineDetail: { Qty: 1, UnitPrice: 1500.00 },
      },
    ],
    ...overrides,
  };
}

export function createCustomer(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'cust-001',
    DisplayName: 'Acme Corp',
    PrimaryEmailAddr: { Address: 'billing@acme.com' },
    PrimaryPhone: { FreeFormNumber: '555-1234' },
    Balance: 3000.00,
    Active: true,
    ...overrides,
  };
}

export function createBill(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'bill-001',
    DocNumber: '2001',
    TxnDate: '2024-01-20',
    DueDate: '2024-02-20',
    Balance: 250.00,
    TotalAmt: 250.00,
    VendorRef: { value: 'vend-001', name: 'Office Depot' },
    ...overrides,
  };
}

export function createVendor(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'vend-001',
    DisplayName: 'Office Depot',
    PrimaryEmailAddr: { Address: 'supplies@officedepot.com' },
    PrimaryPhone: { FreeFormNumber: '555-9876' },
    Balance: 500.00,
    Active: true,
    ...overrides,
  };
}

export function createAccount(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'acct-001',
    Name: 'Office Expenses',
    AccountType: 'Expense',
    AccountSubType: 'OfficeGeneralAdministrativeExpenses',
    CurrentBalance: 12500.00,
    Active: true,
    ...overrides,
  };
}

export function createEmployee(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'emp-001',
    DisplayName: 'John Smith',
    PrimaryEmailAddr: { Address: 'john@acme.com' },
    PrimaryPhone: { FreeFormNumber: '555-5678' },
    Active: true,
    ...overrides,
  };
}

export function createInvoicesQueryResponse(count = 2) {
  return {
    QueryResponse: {
      Invoice: Array.from({ length: count }, (_, i) =>
        createInvoice({ Id: `inv-${String(i + 1).padStart(3, '0')}`, DocNumber: `${1001 + i}` }),
      ),
    },
  };
}

export function createCustomersQueryResponse(count = 2) {
  return {
    QueryResponse: {
      Customer: Array.from({ length: count }, (_, i) =>
        createCustomer({ Id: `cust-${String(i + 1).padStart(3, '0')}`, DisplayName: `Customer ${i + 1}` }),
      ),
    },
  };
}

export function createBillsQueryResponse(count = 2) {
  return {
    QueryResponse: {
      Bill: Array.from({ length: count }, (_, i) =>
        createBill({ Id: `bill-${String(i + 1).padStart(3, '0')}`, DocNumber: `${2001 + i}` }),
      ),
    },
  };
}

export function createVendorsQueryResponse(count = 2) {
  return {
    QueryResponse: {
      Vendor: Array.from({ length: count }, (_, i) =>
        createVendor({ Id: `vend-${String(i + 1).padStart(3, '0')}`, DisplayName: `Vendor ${i + 1}` }),
      ),
    },
  };
}

export function createAccountsQueryResponse(count = 2) {
  return {
    QueryResponse: {
      Account: Array.from({ length: count }, (_, i) =>
        createAccount({ Id: `acct-${String(i + 1).padStart(3, '0')}`, Name: `Account ${i + 1}` }),
      ),
    },
  };
}

export function createEmployeesQueryResponse(count = 2) {
  return {
    QueryResponse: {
      Employee: Array.from({ length: count }, (_, i) =>
        createEmployee({ Id: `emp-${String(i + 1).padStart(3, '0')}`, DisplayName: `Employee ${i + 1}` }),
      ),
    },
  };
}

export function createEstimate(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'est-001',
    DocNumber: '3001',
    TxnDate: '2024-01-10',
    ExpirationDate: '2024-02-10',
    TotalAmt: 1500.00,
    TxnStatus: 'Pending',
    CustomerRef: { value: 'cust-001', name: 'Acme Corp' },
    Line: [
      {
        Amount: 1500.00,
        DetailType: 'SalesItemLineDetail',
        Description: 'Consulting services',
        SalesItemLineDetail: { Qty: 1, UnitPrice: 1500.00 },
      },
    ],
    ...overrides,
  };
}

export function createEstimatesQueryResponse(count = 2) {
  return {
    QueryResponse: {
      Estimate: Array.from({ length: count }, (_, i) =>
        createEstimate({ Id: `est-${String(i + 1).padStart(3, '0')}`, DocNumber: `${3001 + i}` }),
      ),
    },
  };
}

export function createReportResponse(reportName = 'ProfitAndLoss') {
  return {
    Header: {
      ReportName: reportName,
      StartPeriod: '2026-01-01',
      EndPeriod: '2026-03-31',
      Currency: 'USD',
    },
    Columns: {
      Column: [
        { ColTitle: '', ColType: 'Account' },
        { ColTitle: 'Total', ColType: 'Money' },
      ],
    },
    Rows: {
      Row: [
        {
          type: 'Section',
          header: { ColData: [{ value: 'Income' }, { value: '' }] },
          Rows: {
            Row: [
              {
                type: 'Data',
                ColData: [{ value: 'Consulting Revenue', id: '84' }, { value: '15000.00' }],
              },
            ],
          },
          Summary: { ColData: [{ value: 'Total Income' }, { value: '15000.00' }] },
        },
      ],
    },
  };
}
