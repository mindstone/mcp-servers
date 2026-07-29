import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';

import { mswServer } from './helpers/setup.js';
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  successTokenHandler,
} from './helpers/vanta-mock-api.js';

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
});
