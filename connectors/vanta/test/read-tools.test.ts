import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';

import { mswServer } from './helpers/setup.js';
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  successTokenHandler,
} from './helpers/vanta-mock-api.js';
import { buildQueryParams } from '../src/api.js';

const paginated = (data: Array<Record<string, unknown>>) =>
  HttpResponse.json({
    results: {
      data,
      pageInfo: {
        endCursor: null,
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
      },
    },
  });

describe('Read tools — documented request contracts', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('caps outgoing page_size query parameters at Vanta\'s documented maximum', () => {
    expect(Object.fromEntries(buildQueryParams({ page_size: 500 }))).toEqual({
      pageSize: '100',
    });
  });

  it('sends only documented query parameters for repaired list filters', async () => {
    const seen = new Map<string, URLSearchParams>();

    mswServer.use(
      successTokenHandler,
      http.get('https://api.vanta.com/v1/vulnerabilities', ({ request }) => {
        seen.set('vulnerabilities', new URL(request.url).searchParams);
        return paginated([]);
      }),
      http.get('https://api.vanta.com/v1/tests', ({ request }) => {
        seen.set('tests', new URL(request.url).searchParams);
        return paginated([]);
      }),
      http.get('https://api.vanta.com/v1/controls', ({ request }) => {
        seen.set('controls', new URL(request.url).searchParams);
        return paginated([]);
      }),
      http.get('https://api.vanta.com/v1/people', ({ request }) => {
        seen.set('people', new URL(request.url).searchParams);
        return paginated([]);
      }),
      http.get('https://api.vanta.com/v1/tests/test_123/entities', ({ request }) => {
        seen.set('testEntities', new URL(request.url).searchParams);
        return paginated([]);
      }),
      http.get('https://api.vanta.com/v1/vendors', ({ request }) => {
        seen.set('vendors', new URL(request.url).searchParams);
        return paginated([]);
      }),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    await testClient.callTool('vanta_list_vulnerabilities', {
      severity: 'HIGH',
      integration_id: 'aws',
      is_deactivated: false,
      page_size: 10,
      page_cursor: 'vuln-cursor',
    });
    await testClient.callTool('vanta_list_tests', {
      status: 'NEEDS_ATTENTION',
      framework: 'soc2',
      page_size: 10,
      page_cursor: 'test-cursor',
    });
    await testClient.callTool('vanta_list_controls', {
      framework: 'soc2',
      page_size: 10,
      page_cursor: 'control-cursor',
    });
    await testClient.callTool('vanta_list_people', {
      email_or_name: 'jane',
      employment_status: 'CURRENT',
      page_size: 10,
      page_cursor: 'people-cursor',
    });
    await testClient.callTool('vanta_query_test_results', {
      test_id: 'test_123',
      entity_status: 'FAILING',
      page_size: 10,
      page_cursor: 'entity-cursor',
    });
    await testClient.callTool('vanta_list_vendors', {
      name: 'Acme',
      status: 'MANAGED',
      page_size: 10,
      page_cursor: 'vendor-cursor',
    });

    expect(Object.fromEntries(seen.get('vulnerabilities') ?? [])).toEqual({
      severity: 'HIGH',
      integrationId: 'aws',
      isDeactivated: 'false',
      pageSize: '10',
      pageCursor: 'vuln-cursor',
    });
    expect(Object.fromEntries(seen.get('tests') ?? [])).toEqual({
      statusFilter: 'NEEDS_ATTENTION',
      frameworkFilter: 'soc2',
      pageSize: '10',
      pageCursor: 'test-cursor',
    });
    expect(Object.fromEntries(seen.get('controls') ?? [])).toEqual({
      frameworkMatchesAny: 'soc2',
      pageSize: '10',
      pageCursor: 'control-cursor',
    });
    expect(Object.fromEntries(seen.get('people') ?? [])).toEqual({
      emailAndNameFilter: 'jane',
      employmentStatus: 'CURRENT',
      pageSize: '10',
      pageCursor: 'people-cursor',
    });
    expect(Object.fromEntries(seen.get('testEntities') ?? [])).toEqual({
      entityStatus: 'FAILING',
      pageSize: '10',
      pageCursor: 'entity-cursor',
    });
    expect(Object.fromEntries(seen.get('vendors') ?? [])).toEqual({
      name: 'Acme',
      statusMatchesAny: 'MANAGED',
      pageSize: '10',
      pageCursor: 'vendor-cursor',
    });
  });

  it('builds compliance summary from documented framework counters', async () => {
    mswServer.use(
      successTokenHandler,
      http.get('https://api.vanta.com/v1/frameworks', ({ request }) => {
        expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
          pageSize: '100',
        });
        return paginated([
          {
            id: 'soc2',
            displayName: 'SOC 2',
            shorthandName: 'SOC 2',
            numControlsCompleted: 43,
            numControlsTotal: 86,
            numDocumentsPassing: 7,
            numDocumentsTotal: 16,
            numTestsPassing: 21,
            numTestsTotal: 46,
          },
        ]);
      }),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const result = await testClient.callTool('vanta_get_compliance_summary', { framework: 'SOC 2' });
    const payload = result.json as {
      ok: boolean;
      summary: {
        frameworks: Record<string, { testsPassing: number; testsTotal: number; testsFailing: number }>;
        totals: { testsPassing: number; testsTotal: number; testsFailing: number };
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.summary.frameworks.soc2).toMatchObject({
      testsPassing: 21,
      testsTotal: 46,
      testsFailing: 25,
    });
    expect(payload.summary.totals).toMatchObject({
      testsPassing: 21,
      testsTotal: 46,
      testsFailing: 25,
    });
  });

  it('vanta_list_frameworks returns documented framework counters', async () => {
    mswServer.use(
      successTokenHandler,
      http.get('https://api.vanta.com/v1/frameworks', ({ request }) => {
        expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
          pageSize: '10',
          pageCursor: 'framework-cursor',
        });
        return paginated([
          {
            id: 'soc2',
            displayName: 'SOC 2',
            shorthandName: 'SOC 2',
            numControlsCompleted: 43,
            numControlsTotal: 86,
            numTestsPassing: 21,
            numTestsTotal: 46,
          },
        ]);
      }),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const result = await testClient.callTool('vanta_list_frameworks', {
      page_size: 10,
      page_cursor: 'framework-cursor',
    });
    const payload = result.json as {
      ok: boolean;
      frameworks: Array<{ id: string; numTestsTotal: number }>;
      count: number;
    };

    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.frameworks[0]?.id).toBe('soc2');
    expect(payload.frameworks[0]?.numTestsTotal).toBe(46);
  });

  it('vanta_get_framework fetches a single framework by ID', async () => {
    mswServer.use(
      successTokenHandler,
      http.get('https://api.vanta.com/v1/frameworks/soc2', () =>
        HttpResponse.json({
          id: 'soc2',
          displayName: 'SOC 2',
          numControlsCompleted: 43,
          numControlsTotal: 86,
          requirementCategories: [],
        }),
      ),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const result = await testClient.callTool('vanta_get_framework', { framework_id: 'soc2' });
    const payload = result.json as { ok: boolean; framework: { id: string } };

    expect(payload.ok).toBe(true);
    expect(payload.framework.id).toBe('soc2');
  });

  it('vanta_get_framework surfaces a structured error for an unknown framework ID', async () => {
    mswServer.use(
      successTokenHandler,
      http.get('https://api.vanta.com/v1/frameworks/nope', () =>
        HttpResponse.json({ message: 'not found' }, { status: 404 }),
      ),
      http.get('https://api.vanta.com/v1/frameworks', () => paginated([])),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const result = await testClient.callTool('vanta_get_framework', { framework_id: 'nope' });
    const payload = result.json as { ok: boolean; code: string };

    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('NOT_FOUND');
  });

  it('vanta_list_policies returns policy review status', async () => {
    mswServer.use(
      successTokenHandler,
      http.get('https://api.vanta.com/v1/policies', ({ request }) => {
        expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
          pageSize: '10',
          pageCursor: 'policy-cursor',
        });
        return paginated([
          {
            id: 'code-of-conduct-bsi',
            name: 'Code of Conduct',
            status: 'NEEDS_REMEDIATION',
            approvedAtDate: '2024-01-15T10:30:00.000Z',
            latestVersion: { status: 'EXPIRED' },
          },
        ]);
      }),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const result = await testClient.callTool('vanta_list_policies', {
      page_size: 10,
      page_cursor: 'policy-cursor',
    });
    const payload = result.json as {
      ok: boolean;
      policies: Array<{ id: string; status: string; latestVersion: { status: string } }>;
      count: number;
    };

    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.policies[0]?.id).toBe('code-of-conduct-bsi');
    expect(payload.policies[0]?.status).toBe('NEEDS_REMEDIATION');
    expect(payload.policies[0]?.latestVersion.status).toBe('EXPIRED');
  });

  it('vanta_get_policy fetches a single policy by ID', async () => {
    mswServer.use(
      successTokenHandler,
      http.get('https://api.vanta.com/v1/policies/code-of-conduct-bsi', () =>
        HttpResponse.json({
          id: 'code-of-conduct-bsi',
          name: 'Code of Conduct',
          status: 'OK',
          latestVersion: { status: 'APPROVED' },
        }),
      ),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const result = await testClient.callTool('vanta_get_policy', { policy_id: 'code-of-conduct-bsi' });
    const payload = result.json as { ok: boolean; policy: { id: string; status: string } };

    expect(payload.ok).toBe(true);
    expect(payload.policy.id).toBe('code-of-conduct-bsi');
    expect(payload.policy.status).toBe('OK');
  });

  it('vanta_get_policy surfaces a structured error for an unknown policy ID', async () => {
    mswServer.use(
      successTokenHandler,
      http.get('https://api.vanta.com/v1/policies/nope', () =>
        HttpResponse.json({ message: 'not found' }, { status: 404 }),
      ),
      http.get('https://api.vanta.com/v1/policies', () => paginated([])),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const result = await testClient.callTool('vanta_get_policy', { policy_id: 'nope' });
    const payload = result.json as { ok: boolean; code: string };

    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('NOT_FOUND');
  });

  it('vanta_list_integrations returns connection health per integration', async () => {
    mswServer.use(
      successTokenHandler,
      http.get('https://api.vanta.com/v1/integrations', ({ request }) => {
        expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
          pageSize: '10',
          pageCursor: 'integration-cursor',
        });
        return paginated([
          {
            integrationId: 'asana',
            displayName: 'Asana',
            resourceKinds: ['AsanaAccount'],
            connections: [
              {
                connectionId: '62ffd6793ef7978318baefa8',
                isDisabled: true,
                connectionErrorMessage: 'Authorization Error connecting to Asana',
              },
            ],
          },
        ]);
      }),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const result = await testClient.callTool('vanta_list_integrations', {
      page_size: 10,
      page_cursor: 'integration-cursor',
    });
    const payload = result.json as {
      ok: boolean;
      integrations: Array<{
        integrationId: string;
        connections: Array<{ isDisabled: boolean; connectionErrorMessage: string }>;
      }>;
      count: number;
    };

    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.integrations[0]?.integrationId).toBe('asana');
    expect(payload.integrations[0]?.connections[0]?.isDisabled).toBe(true);
    // Integration error text is external content and must be enveloped.
    expect(payload.integrations[0]?.connections[0]?.connectionErrorMessage).toBe(
      '<untrusted-content source="vanta:connectionErrorMessage">Authorization Error connecting to Asana</untrusted-content>',
    );
  });

  it('vanta_list_integrations surfaces a structured error when the API fails', async () => {
    mswServer.use(
      successTokenHandler,
      http.get('https://api.vanta.com/v1/integrations', () =>
        HttpResponse.json({ message: 'server error' }, { status: 500 }),
      ),
    );

    const { createServer } = await import('../src/server.js');
    testClient = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });

    const result = await testClient.callTool('vanta_list_integrations', {});
    const payload = result.json as { ok: boolean; code: string };

    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('API_ERROR');
  });
});
