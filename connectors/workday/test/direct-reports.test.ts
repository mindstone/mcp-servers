import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createWorkdayHandlers } from './helpers/workday-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import {
  MOCK_HOST,
  MOCK_TENANT,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  TOKEN_URL,
  API_BASE,
  createTokenResponse,
} from './fixtures/workday-data.js';

const CONFIGURED_ENV = {
  WORKDAY_HOST: MOCK_HOST,
  WORKDAY_TENANT: MOCK_TENANT,
  WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
  WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
  MCP_HOST_BRIDGE_STATE: '',
};

describe('list_workday_direct_reports', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns direct reports with only allowed fields', async () => {
    mswServer.use(...createWorkdayHandlers());

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_direct_reports', { worker_id: 'worker-001' });
    const json = result.json as {
      ok: boolean;
      direct_reports: Array<Record<string, unknown>>;
      count: number;
      total: number;
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThan(0);
    const report = json.direct_reports[0];
    expect(report.id).toBeDefined();
    expect(report.descriptor).toBeDefined();
    // Allowlist strips sensitive fields from the underlying worker objects
    expect(report.ssn).toBeUndefined();
    expect(report.salary).toBeUndefined();
    expect(report.homeAddress).toBeUndefined();
  });

  it('hits the worker directReports endpoint with pagination params', async () => {
    let capturedUrl: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${API_BASE}/workers/:workerId/directReports`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    await testClient.callTool('list_workday_direct_reports', { worker_id: 'worker- 001', limit: 10, offset: 5 });
    expect(capturedUrl).toContain(`/workers/${encodeURIComponent('worker- 001')}/directReports`);
    expect(capturedUrl).toContain('limit=10');
    expect(capturedUrl).toContain('offset=5');
  });

  it('returns not-configured error when credentials missing', async () => {
    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: '',
        WORKDAY_TENANT: '',
        WORKDAY_CLIENT_ID: '',
        WORKDAY_CLIENT_SECRET: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_workday_direct_reports', { worker_id: 'worker-001' });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });

  it('surfaces a structured error when the API rejects the request', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${API_BASE}/workers/:workerId/directReports`, async () =>
        HttpResponse.json({ error: 'Not found' }, { status: 404 }),
      ),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_direct_reports', { worker_id: 'nonexistent' });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('NOT_FOUND');
  });
});
