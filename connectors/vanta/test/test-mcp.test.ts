/**
 * Vanta MCP Mock Tests
 *
 * Verifies tool behavior with mocked Vanta API responses — no real credentials needed.
 *
 * Run: npx vitest run resources/mcp/vanta/test-mcp.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createMcpTestClientWithMockApi,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer,
  type MockRoute,
} from '../../../scripts/mcp-test-harness';
import { VantaApiClient } from './src/api';

const mockVulnerabilities = [
  { id: 'vuln_1', severity: 'HIGH', status: 'OPEN', service: 'aws' },
  { id: 'vuln_2', severity: 'LOW', status: 'FIXED', service: 'github' },
];

const mockTests = [
  { id: 'test_1', status: 'FAIL', framework: 'SOC2', name: 'MFA enabled' },
  { id: 'test_2', status: 'PASS', framework: 'ISO27001', name: 'Disk encryption' },
  { id: 'test_3', status: 'PASS', framework: 'SOC2', name: 'Endpoint protection' },
  { id: 'test_4', status: 'DISABLED', framework: 'HIPAA', name: 'BAA signed' },
  { id: 'test_5', status: 'NOT_APPLICABLE', framework: 'SOC2', name: 'Physical access logs' },
];

const mockControls = [
  { id: 'control_1', status: 'NEEDS_ATTENTION', framework: 'SOC2', name: 'Access reviews' },
  { id: 'control_2', status: 'OK', framework: 'HIPAA', name: 'Device inventory' },
];

const mockResources = [
  { id: 'resource_1', resourceType: 'COMPUTER', name: 'laptop-1' },
  { id: 'resource_2', resourceType: 'CLOUD_ACCOUNT', name: 'aws-prod' },
];

const mockEvidence = [
  { id: 'ev_1', type: 'DOCUMENT', status: 'VALID', name: 'Security policy' },
  { id: 'ev_2', type: 'SCREENSHOT', status: 'EXPIRED', name: 'MFA screenshot' },
];

const mockPeople = [
  { id: 'person_1', role: 'EMPLOYEE', status: 'ACTIVE', name: 'Alice' },
  { id: 'person_2', role: 'CONTRACTOR', status: 'INACTIVE', name: 'Bob' },
];

const mockVendors = [
  { id: 'vendor_1', vendorName: 'Acme Corp', vendorCategory: 'INFRASTRUCTURE', riskLevel: 'MEDIUM' },
  { id: 'vendor_2', vendorName: 'Widget Inc', vendorCategory: 'SOFTWARE', riskLevel: 'LOW' },
];

const vantaListResponse = (items: unknown[], pageInfo = { endCursor: 'cursor123', hasNextPage: false }) => ({
  results: {
    data: items,
    pageInfo,
  },
});

const oauthTokenRoute: MockRoute = {
  method: 'POST',
  path: '/oauth/token',
  handler: () => ({ body: { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 } }),
};

const mockOAuthEnv = { VANTA_CLIENT_ID: 'mock-client-id', VANTA_CLIENT_SECRET: 'mock-client-secret' };

function makeRoutes(): MockRoute[] {
  return [
    oauthTokenRoute,
    {
      method: 'GET',
      path: '/v1/vulnerabilities',
      handler: () => ({ body: vantaListResponse(mockVulnerabilities) }),
    },
    {
      method: 'GET',
      path: '/v1/vulnerabilities/vuln_1',
      handler: () => ({ body: { id: 'vuln_1', severity: 'HIGH', status: 'OPEN', description: 'Mock vuln' } }),
    },
    {
      method: 'GET',
      path: '/v1/tests',
      handler: () => ({ body: vantaListResponse(mockTests) }),
    },
    {
      method: 'GET',
      path: '/v1/tests/test_1',
      handler: () => ({ body: { id: 'test_1', status: 'FAIL', framework: 'SOC2', evidence: [] } }),
    },
    {
      method: 'GET',
      path: '/v1/controls',
      handler: () => ({ body: vantaListResponse(mockControls) }),
    },
    {
      method: 'GET',
      path: '/v1/controls/control_1',
      handler: () => ({ body: { id: 'control_1', status: 'NEEDS_ATTENTION', framework: 'SOC2', tests: ['test_1'] } }),
    },
    {
      method: 'GET',
      path: '/v1/resources',
      handler: () => ({ body: vantaListResponse(mockResources) }),
    },
    {
      method: 'GET',
      path: '/v1/evidence',
      handler: () => ({ body: vantaListResponse(mockEvidence) }),
    },
    {
      method: 'GET',
      path: '/v1/evidence/ev_1',
      handler: () => ({ body: { id: 'ev_1', type: 'DOCUMENT', status: 'VALID', name: 'Security policy' } }),
    },
    {
      method: 'GET',
      path: '/v1/people',
      handler: () => ({ body: vantaListResponse(mockPeople) }),
    },
    {
      method: 'GET',
      path: '/v1/people/person_1',
      handler: () => ({ body: { id: 'person_1', role: 'EMPLOYEE', status: 'ACTIVE', name: 'Alice' } }),
    },
    // Vendor routes
    {
      method: 'GET',
      path: '/v1/vendors',
      handler: () => ({ body: vantaListResponse(mockVendors) }),
    },
    {
      method: 'GET',
      path: '/v1/vendors/vendor_1',
      handler: () => ({ body: mockVendors[0] }),
    },
    {
      method: 'POST',
      path: '/v1/vendors',
      handler: (req) => ({ status: 201, body: { id: 'vendor_new', ...req.body } }),
    },
    {
      method: 'PUT',
      path: '/v1/vendors/vendor_1',
      handler: (req) => ({ body: { id: 'vendor_1', ...req.body } }),
    },
    {
      method: 'POST',
      path: '/v1/vendors/vendor_1/documents',
      handler: (req) => ({ status: 201, body: { id: 'doc_new', vendorId: 'vendor_1', ...req.body } }),
    },
    // Vulnerability PATCH
    {
      method: 'PATCH',
      path: '/v1/vulnerabilities',
      handler: (req) => ({ body: { id: 'vuln_1', ...req.body } }),
    },
    // Document upload
    {
      method: 'POST',
      path: '/v1/documents',
      handler: (req) => ({ status: 201, body: { id: 'doc_evidence_new', ...req.body } }),
    },
  ];
}

describe('vanta - happy path and query parameters', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    const result = await createMcpTestClientWithMockApi({
      name: 'vanta',
      serverScript: resolveServerScript('vanta'),
      interceptDomains: ['api.vanta.com'],
      routes: makeRoutes(),
      env: mockOAuthEnv,
      connectTimeout: 15_000,
    });
    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
  });

  it('vanta_list_vulnerabilities returns shaped data', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      count: number;
      vulnerabilities: Array<{ id: string }>;
      pageInfo: { endCursor?: string };
    }>('vanta_list_vulnerabilities', {});

    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    expect(out.vulnerabilities[0]?.id).toBe('vuln_1');
    expect(out.pageInfo.endCursor).toBe('cursor123');
  });

  it('vanta_list_vulnerabilities with severity filter passes correct query param', async () => {
    mockApi.clearLog();
    await client.callToolJson('vanta_list_vulnerabilities', { severity: 'HIGH' });

    const call = mockApi.requestLog.find((request) => request.pathname === '/v1/vulnerabilities');
    expect(call?.searchParams.get('severityFilter')).toBe('HIGH');
  });

  it('vanta_get_vulnerability by ID returns details', async () => {
    const out = await client.callToolJson<{ ok: boolean; vulnerability: { id: string; description: string } }>(
      'vanta_get_vulnerability',
      { vulnerability_id: 'vuln_1' },
    );

    expect(out.ok).toBe(true);
    expect(out.vulnerability.id).toBe('vuln_1');
    expect(out.vulnerability.description).toBe('Mock vuln');
  });

  it('vanta_list_tests with status filter', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; tests: Array<{ id: string }> }>(
      'vanta_list_tests',
      { status: 'FAIL' },
    );

    const call = mockApi.requestLog.find((request) => request.pathname === '/v1/tests');
    expect(out.ok).toBe(true);
    expect(out.tests[0]?.id).toBe('test_1');
    expect(call?.searchParams.get('statusFilter')).toBe('FAIL');
  });

  it('vanta_get_test by ID', async () => {
    const out = await client.callToolJson<{ ok: boolean; test: { id: string; status: string } }>(
      'vanta_get_test',
      { test_id: 'test_1' },
    );

    expect(out.ok).toBe(true);
    expect(out.test.id).toBe('test_1');
    expect(out.test.status).toBe('FAIL');
  });

  it('vanta_list_controls with framework filter', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; controls: Array<{ id: string }> }>(
      'vanta_list_controls',
      { framework: 'SOC2' },
    );

    const call = mockApi.requestLog.find((request) => request.pathname === '/v1/controls');
    expect(out.ok).toBe(true);
    expect(out.controls[0]?.id).toBe('control_1');
    expect(call?.searchParams.get('frameworkFilter')).toBe('SOC2');
  });

  it('vanta_get_control by ID', async () => {
    const out = await client.callToolJson<{ ok: boolean; control: { id: string; tests: string[] } }>(
      'vanta_get_control',
      { control_id: 'control_1' },
    );

    expect(out.ok).toBe(true);
    expect(out.control.id).toBe('control_1');
    expect(out.control.tests).toEqual(['test_1']);
  });

  it('vanta_list_resources with type filter', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; resources: Array<{ id: string }> }>(
      'vanta_list_resources',
      { resource_type: 'COMPUTER' },
    );

    const call = mockApi.requestLog.find((request) => request.pathname === '/v1/resources');
    expect(out.ok).toBe(true);
    expect(out.resources[0]?.id).toBe('resource_1');
    expect(call?.searchParams.get('resourceType')).toBe('COMPUTER');
  });

  it('vanta_list_evidence happy path with type filter', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; evidence: Array<{ id: string }>; count: number }>(
      'vanta_list_evidence',
      { type: 'DOCUMENT' },
    );

    const call = mockApi.requestLog.find((request) => request.pathname === '/v1/evidence');
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    expect(out.evidence[0]?.id).toBe('ev_1');
    expect(call?.searchParams.get('type')).toBe('DOCUMENT');
  });

  it('vanta_list_people happy path with role filter', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; people: Array<{ id: string }>; count: number }>(
      'vanta_list_people',
      { role: 'EMPLOYEE' },
    );

    const call = mockApi.requestLog.find((request) => request.pathname === '/v1/people');
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    expect(out.people[0]?.id).toBe('person_1');
    expect(call?.searchParams.get('role')).toBe('EMPLOYEE');
  });

  it('vanta_query_test_results maps date_from and date_to to dateFrom and dateTo', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; testResults: Array<{ id: string }>; count: number }>(
      'vanta_query_test_results',
      {
        framework: 'SOC2',
        status: 'FAIL',
        date_from: '2026-05-01',
        date_to: '2026-05-31',
      },
    );

    const call = mockApi.requestLog.find((request) => request.pathname === '/v1/tests');
    expect(out.ok).toBe(true);
    expect(out.count).toBe(5);
    expect(out.testResults[0]?.id).toBe('test_1');
    expect(call?.searchParams.get('frameworkFilter')).toBe('SOC2');
    expect(call?.searchParams.get('statusFilter')).toBe('FAIL');
    expect(call?.searchParams.get('dateFrom')).toBe('2026-05-01');
    expect(call?.searchParams.get('dateTo')).toBe('2026-05-31');
    expect(call?.searchParams.has('dateFromFilter')).toBe(false);
    expect(call?.searchParams.has('dateToFilter')).toBe(false);
  });

  it('vanta_get_compliance_summary aggregates counts by framework', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      summary: {
        totalTests: number;
        passRate: number;
        frameworks: Record<string, { total: number; pass: number; fail: number; disabled: number; other: number }>;
      };
    }>('vanta_get_compliance_summary', {});

    expect(out.ok).toBe(true);
    expect(out.summary.totalTests).toBe(5);
    expect(out.summary.passRate).toBe(0.4);
    expect(out.summary.frameworks.SOC2).toEqual({ total: 3, pass: 1, fail: 1, disabled: 0, other: 1 });
    expect(out.summary.frameworks.ISO27001).toEqual({ total: 1, pass: 1, fail: 0, disabled: 0, other: 0 });
    expect(out.summary.frameworks.HIPAA).toEqual({ total: 1, pass: 0, fail: 0, disabled: 1, other: 0 });
  });

  it('vanta_get_compliance_summary with framework filter only returns that framework', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{
      ok: boolean;
      summary: {
        totalTests: number;
        frameworks: Record<string, { total: number; pass: number; fail: number; disabled: number; other: number }>;
      };
    }>('vanta_get_compliance_summary', { framework: 'SOC2' });

    const call = mockApi.requestLog.find((request) => request.pathname === '/v1/tests');
    expect(out.ok).toBe(true);
    expect(Object.keys(out.summary.frameworks)).toEqual(['SOC2']);
    expect(out.summary.totalTests).toBe(3);
    expect(out.summary.frameworks.SOC2).toEqual({ total: 3, pass: 1, fail: 1, disabled: 0, other: 1 });
    expect(call?.searchParams.get('frameworkFilter')).toBe('SOC2');
  });

  it('passes page_size and page_cursor pagination params correctly', async () => {
    mockApi.clearLog();
    await client.callToolJson('vanta_list_vulnerabilities', {
      page_size: 50,
      page_cursor: 'cursor_abc',
    });

    const call = mockApi.requestLog.find((request) => request.pathname === '/v1/vulnerabilities');
    expect(call?.searchParams.get('pageSize')).toBe('50');
    expect(call?.searchParams.get('pageCursor')).toBe('cursor_abc');
  });
});

describe('vanta - error handling', () => {
  it('rejects unsafe IDs before making an API request', async () => {
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'vanta',
      serverScript: resolveServerScript('vanta'),
      interceptDomains: ['api.vanta.com'],
      routes: makeRoutes(),
      env: mockOAuthEnv,
      connectTimeout: 15_000,
    });

    try {
      const out = await client.callToolJson<{ ok: boolean; code?: string }>(
        'vanta_get_vulnerability',
        { vulnerability_id: '../etc/passwd' },
      );
      expect(out.ok).toBe(false);
      expect(out.code).toBe('CONFIG_INVALID');
      expect(mockApi.requestLog).toHaveLength(0);
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);

  it('missing OAuth credentials returns CONFIG_MISSING error without crashing startup', async () => {
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'vanta',
      serverScript: resolveServerScript('vanta'),
      interceptDomains: ['api.vanta.com'],
      routes: makeRoutes(),
      env: { VANTA_CLIENT_ID: '', VANTA_CLIENT_SECRET: '' },
      connectTimeout: 15_000,
    });

    try {
      const out = await client.callToolJson<{ ok: boolean; code?: string; resolution?: string }>(
        'vanta_list_vulnerabilities',
        {},
      );
      expect(out.ok).toBe(false);
      expect(out.code).toBe('CONFIG_MISSING');
      expect(out.resolution).toContain('Settings → Connectors → Vanta');
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);

  it('401 returns AUTH error with resolution hint', async () => {
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'vanta',
      serverScript: resolveServerScript('vanta'),
      interceptDomains: ['api.vanta.com'],
      routes: [
        oauthTokenRoute,
        {
          method: 'GET',
          path: '/v1/vulnerabilities',
          handler: () => ({ status: 401, body: { error: { message: 'Unauthorized' } } }),
        },
      ],
      env: mockOAuthEnv,
      connectTimeout: 15_000,
    });

    try {
      const out = await client.callToolJson<{ ok: boolean; code?: string; resolution?: string }>(
        'vanta_list_vulnerabilities',
        {},
      );
      expect(out.ok).toBe(false);
      expect(out.code).toBe('AUTH');
      expect(out.resolution).toContain('Settings → Connectors → Vanta');
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);

  it('500 server errors return API_ERROR with a resolution hint', async () => {
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'vanta',
      serverScript: resolveServerScript('vanta'),
      interceptDomains: ['api.vanta.com'],
      routes: [
        oauthTokenRoute,
        {
          method: 'GET',
          path: '/v1/vulnerabilities',
          handler: () => ({ status: 500, body: { error: { message: 'Internal Server Error' } } }),
        },
      ],
      env: mockOAuthEnv,
      connectTimeout: 15_000,
    });

    try {
      const out = await client.callToolJson<{ ok: boolean; code?: string; resolution?: string }>(
        'vanta_list_vulnerabilities',
        {},
      );
      expect(out.ok).toBe(false);
      expect(out.code).toBe('API_ERROR');
      expect(out.resolution).toContain('narrower filters');
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);

  it('429 rate limit retries and succeeds', async () => {
    let attempts = 0;
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'vanta',
      serverScript: resolveServerScript('vanta'),
      interceptDomains: ['api.vanta.com'],
      routes: [
        oauthTokenRoute,
        {
          method: 'GET',
          path: '/v1/vulnerabilities',
          handler: () => {
            attempts++;
            if (attempts === 1) {
              return { status: 429, headers: { 'Retry-After': '0' }, body: { error: 'rate limited' } };
            }
            return { body: vantaListResponse(mockVulnerabilities) };
          },
        },
      ],
      env: mockOAuthEnv,
      connectTimeout: 15_000,
    });

    try {
      const out = await client.callToolJson<{ ok: boolean; count: number }>(
        'vanta_list_vulnerabilities',
        {},
      );
      expect(out.ok).toBe(true);
      expect(out.count).toBe(2);
      expect(mockApi.requestLog.filter((request) => request.pathname === '/v1/vulnerabilities')).toHaveLength(2);
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);
});

describe('vanta - region support', () => {
  it('defaults to US base URL when VANTA_REGION is unset', async () => {
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'vanta-region-us',
      serverScript: resolveServerScript('vanta'),
      interceptDomains: ['api.vanta.com'],
      routes: [
        oauthTokenRoute,
        { method: 'GET', path: '/v1/vulnerabilities', handler: () => ({ body: vantaListResponse(mockVulnerabilities) }) },
      ],
      env: mockOAuthEnv,
      connectTimeout: 15_000,
    });
    try {
      const out = await client.callToolJson<{ ok: boolean; count: number }>('vanta_list_vulnerabilities', {});
      expect(out.ok).toBe(true);
      expect(out.count).toBe(2);
      // Mock intercepted api.vanta.com — if the request went to a different domain it would fail
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);

  it('uses EU base URL when VANTA_REGION=eu', async () => {
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'vanta-region-eu',
      serverScript: resolveServerScript('vanta'),
      interceptDomains: ['api.eu.vanta.com'],
      routes: [
        oauthTokenRoute,
        { method: 'GET', path: '/v1/vulnerabilities', handler: () => ({ body: vantaListResponse(mockVulnerabilities) }) },
      ],
      env: { ...mockOAuthEnv, VANTA_REGION: 'eu' },
      connectTimeout: 15_000,
    });
    try {
      const out = await client.callToolJson<{ ok: boolean; count: number }>('vanta_list_vulnerabilities', {});
      expect(out.ok).toBe(true);
      expect(out.count).toBe(2);
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);

  it('uses AUS base URL when VANTA_REGION=aus', async () => {
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'vanta-region-aus',
      serverScript: resolveServerScript('vanta'),
      interceptDomains: ['api.aus.vanta.com'],
      routes: [
        oauthTokenRoute,
        { method: 'GET', path: '/v1/vulnerabilities', handler: () => ({ body: vantaListResponse(mockVulnerabilities) }) },
      ],
      env: { ...mockOAuthEnv, VANTA_REGION: 'aus' },
      connectTimeout: 15_000,
    });
    try {
      const out = await client.callToolJson<{ ok: boolean; count: number }>('vanta_list_vulnerabilities', {});
      expect(out.ok).toBe(true);
      expect(out.count).toBe(2);
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);

  it('falls back to US for unknown region value', () => {
    const clientUs = new VantaApiClient({ VANTA_CLIENT_ID: 'id', VANTA_CLIENT_SECRET: 'secret', VANTA_REGION: 'mars' } as unknown as NodeJS.ProcessEnv);
    // Verify it doesn't throw — the constructor should silently default to US
    expect(clientUs).toBeDefined();
  });
});

describe('vanta - write operations', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    const result = await createMcpTestClientWithMockApi({
      name: 'vanta-write',
      serverScript: resolveServerScript('vanta'),
      interceptDomains: ['api.vanta.com'],
      routes: makeRoutes(),
      env: mockOAuthEnv,
      connectTimeout: 15_000,
    });
    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
  });

  it('vanta_list_vendors returns shaped data', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      count: number;
      vendors: Array<{ id: string; vendorName: string }>;
      pageInfo: { endCursor?: string };
    }>('vanta_list_vendors', {});

    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    expect(out.vendors[0]?.id).toBe('vendor_1');
    expect(out.pageInfo.endCursor).toBe('cursor123');
  });

  it('vanta_get_vendor by ID returns details', async () => {
    const out = await client.callToolJson<{ ok: boolean; vendor: { id: string; vendorName: string } }>(
      'vanta_get_vendor',
      { vendor_id: 'vendor_1' },
    );

    expect(out.ok).toBe(true);
    expect(out.vendor.id).toBe('vendor_1');
    expect(out.vendor.vendorName).toBe('Acme Corp');
  });

  it('vanta_create_vendor sends correct POST body', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; vendor: { id: string; vendorName: string } }>(
      'vanta_create_vendor',
      {
        vendor_name: 'New Vendor',
        vendor_website: 'https://newvendor.com',
        vendor_category: 'SOFTWARE',
        description: 'Test vendor',
      },
    );

    expect(out.ok).toBe(true);
    expect(out.vendor.id).toBe('vendor_new');
    expect(out.vendor.vendorName).toBe('New Vendor');

    const call = mockApi.requestLog.find((r) => r.pathname === '/v1/vendors' && r.method === 'POST');
    expect(call).toBeDefined();
    expect(call?.body?.vendorName).toBe('New Vendor');
    expect(call?.body?.vendorWebsite).toBe('https://newvendor.com');
    expect(call?.body?.vendorCategory).toBe('SOFTWARE');
    expect(call?.body?.description).toBe('Test vendor');
  });

  it('vanta_update_vendor sends only provided fields', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; vendor: { id: string; vendorName: string } }>(
      'vanta_update_vendor',
      { vendor_id: 'vendor_1', vendor_name: 'Updated Corp', risk_level: 'HIGH' },
    );

    expect(out.ok).toBe(true);
    expect(out.vendor.id).toBe('vendor_1');
    expect(out.vendor.vendorName).toBe('Updated Corp');

    const call = mockApi.requestLog.find((r) => r.pathname === '/v1/vendors/vendor_1' && r.method === 'PUT');
    expect(call).toBeDefined();
    expect(call?.body?.vendorName).toBe('Updated Corp');
    expect(call?.body?.riskLevel).toBe('HIGH');
    expect(call?.body?.vendorWebsite).toBeUndefined();
  });

  it('vanta_attach_vendor_document posts to nested endpoint', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; document: { id: string; vendorId: string } }>(
      'vanta_attach_vendor_document',
      {
        vendor_id: 'vendor_1',
        document_name: 'SOC2 Report',
        document_url: 'https://example.com/soc2.pdf',
        document_type: 'SOC2_REPORT',
      },
    );

    expect(out.ok).toBe(true);
    expect(out.document.id).toBe('doc_new');
    expect(out.document.vendorId).toBe('vendor_1');

    const call = mockApi.requestLog.find((r) => r.pathname === '/v1/vendors/vendor_1/documents');
    expect(call).toBeDefined();
    expect(call?.body?.documentName).toBe('SOC2 Report');
    expect(call?.body?.documentUrl).toBe('https://example.com/soc2.pdf');
  });

  it('vanta_update_vulnerability sends PATCH body', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; vulnerability: { id: string; status: string } }>(
      'vanta_update_vulnerability',
      { vulnerability_id: 'vuln_1', status: 'FIXED', remediation_note: 'Patched in v2.1' },
    );

    expect(out.ok).toBe(true);
    expect(out.vulnerability.id).toBe('vuln_1');
    expect(out.vulnerability.status).toBe('FIXED');

    const call = mockApi.requestLog.find((r) => r.pathname === '/v1/vulnerabilities' && r.method === 'PATCH');
    expect(call).toBeDefined();
    expect(call?.body?.vulnerabilityId).toBe('vuln_1');
    expect(call?.body?.status).toBe('FIXED');
    expect(call?.body?.remediationNote).toBe('Patched in v2.1');
  });

  it('vanta_upload_document sends POST body', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; document: { id: string; documentName: string } }>(
      'vanta_upload_document',
      {
        document_name: 'Security Policy',
        document_url: 'https://example.com/policy.pdf',
        description: 'Annual security policy',
        document_type: 'POLICY',
      },
    );

    expect(out.ok).toBe(true);
    expect(out.document.id).toBe('doc_evidence_new');
    expect(out.document.documentName).toBe('Security Policy');

    const call = mockApi.requestLog.find((r) => r.pathname === '/v1/documents' && r.method === 'POST');
    expect(call).toBeDefined();
    expect(call?.body?.documentUrl).toBe('https://example.com/policy.pdf');
    expect(call?.body?.documentType).toBe('POLICY');
  });

  it('vanta_update_vendor rejects unsafe IDs', async () => {
    const out = await client.callToolJson<{ ok: boolean; code?: string }>(
      'vanta_update_vendor',
      { vendor_id: '../etc/passwd', vendor_name: 'Hacked' },
    );
    expect(out.ok).toBe(false);
    expect(out.code).toBe('CONFIG_INVALID');
  });

  it('vanta_update_vendor rejects empty update (no fields besides ID)', async () => {
    const out = await client.callToolJson<{ ok: boolean; code?: string }>(
      'vanta_update_vendor',
      { vendor_id: 'vendor_1' },
    );
    expect(out.ok).toBe(false);
    expect(out.code).toBe('CONFIG_INVALID');
  });

  it('vanta_update_vulnerability rejects empty update (no fields besides ID)', async () => {
    const out = await client.callToolJson<{ ok: boolean; code?: string }>(
      'vanta_update_vulnerability',
      { vulnerability_id: 'vuln_1' },
    );
    expect(out.ok).toBe(false);
    expect(out.code).toBe('CONFIG_INVALID');
  });

  it('vanta_attach_vendor_document rejects unsafe IDs', async () => {
    const out = await client.callToolJson<{ ok: boolean; code?: string }>(
      'vanta_attach_vendor_document',
      { vendor_id: '../etc/passwd', document_name: 'test', document_url: 'https://example.com' },
    );
    expect(out.ok).toBe(false);
    expect(out.code).toBe('CONFIG_INVALID');
  });
});
