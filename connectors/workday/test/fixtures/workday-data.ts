/**
 * Test data factories for Workday MCP connector tests.
 */

export const MOCK_HOST = 'wd5-impl-services1.workday.com';
export const MOCK_TENANT = 'acme_corp';
export const MOCK_CLIENT_ID = 'test-client-id';
export const MOCK_CLIENT_SECRET = 'test-client-secret';
export const MOCK_REFRESH_TOKEN = 'test-refresh-token';
export const MOCK_ACCESS_TOKEN = 'test-access-token-abc123';

export const TOKEN_URL = `https://${MOCK_HOST}/ccx/oauth2/${MOCK_TENANT}/token`;
export const API_BASE = `https://${MOCK_HOST}/ccx/api/v1/${MOCK_TENANT}`;

export function createTokenResponse(overrides: Partial<{
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
}> = {}) {
  return {
    access_token: MOCK_ACCESS_TOKEN,
    token_type: 'Bearer',
    expires_in: 3600,
    ...overrides,
  };
}

export function createWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: 'worker-001',
    descriptor: 'Jane Smith',
    primaryWorkEmail: 'jane.smith@acme.com',
    businessTitle: 'Software Engineer',
    isManager: false,
    yearsOfService: 3,
    href: '/workers/worker-001',
    // Sensitive fields that should be stripped by allowlisting
    ssn: '123-45-6789',
    dateOfBirth: '1990-01-15',
    homeAddress: '123 Main St, Springfield',
    salary: 150000,
    location: {
      id: 'loc-001',
      descriptor: 'San Francisco Office',
      address: '123 Market St',
      postalCode: '94105',
    },
    supervisoryOrganization: {
      id: 'org-001',
      descriptor: 'Engineering',
      headcount: 50,
      budget: 5000000,
    },
    ...overrides,
  };
}

export function createOrganization(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org-001',
    descriptor: 'Engineering',
    type: 'Supervisory',
    isActive: true,
    href: '/organizations/org-001',
    // Sensitive fields that should be stripped
    budget: 5000000,
    headcount: 50,
    costCenter: 'CC-1234',
    ...overrides,
  };
}

export function createWorkersListResponse(count = 2, total = 10) {
  const data = Array.from({ length: count }, (_, i) => createWorker({
    id: `worker-${String(i + 1).padStart(3, '0')}`,
    descriptor: `Worker ${i + 1}`,
    primaryWorkEmail: `worker${i + 1}@acme.com`,
  }));
  return { data, total };
}

export function createOrgsListResponse(count = 2, total = 5) {
  const data = Array.from({ length: count }, (_, i) => createOrganization({
    id: `org-${String(i + 1).padStart(3, '0')}`,
    descriptor: `Organization ${i + 1}`,
  }));
  return { data, total };
}

export function createDirectReportsResponse(count = 2, total = 2) {
  const data = Array.from({ length: count }, (_, i) => createWorker({
    id: `report-${String(i + 1).padStart(3, '0')}`,
    descriptor: `Report ${i + 1}`,
    primaryWorkEmail: `report${i + 1}@acme.com`,
  }));
  return { data, total };
}
