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
  RECRUITING_API_BASE,
  createTokenResponse,
} from './fixtures/workday-data.js';

const CONFIGURED_ENV = {
  WORKDAY_HOST: MOCK_HOST,
  WORKDAY_TENANT: MOCK_TENANT,
  WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
  WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
  MCP_HOST_BRIDGE_STATE: '',
};

describe('list_workday_job_requisitions', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns requisitions with only allowed fields', async () => {
    mswServer.use(...createWorkdayHandlers());

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_job_requisitions', {});
    const json = result.json as {
      ok: boolean;
      job_requisitions: Array<Record<string, unknown>>;
      count: number;
      total: number;
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThan(0);
    const req = json.job_requisitions[0];
    expect(req.id).toBeDefined();
    expect(req.descriptor).toBeDefined();
    expect((req.hiringManager as Record<string, unknown>).descriptor).toBe('Jane Manager');
    // Free-text and sensitive fields are stripped by the allowlist
    expect(req.jobDescription).toBeUndefined();
    expect(req.justification).toBeUndefined();
    expect((req.hiringManager as Record<string, unknown>).salary).toBeUndefined();
    expect((req.supervisoryOrganization as Record<string, unknown>).headcount).toBeUndefined();
  });

  it('defaults to the recruiting v41.2 family', async () => {
    let capturedUrl: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${RECRUITING_API_BASE}/jobRequisitions`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    await testClient.callTool('list_workday_job_requisitions', { limit: 10 });
    expect(capturedUrl).toContain('/ccx/api/recruiting/v41.2/');
    expect(capturedUrl).toContain('limit=10');
  });

  it('honours the WORKDAY_RECRUITING_API_VERSION override', async () => {
    let capturedUrl: string | null = null;
    const overrideBase = `https://${MOCK_HOST}/ccx/api/recruiting/v42.1/${MOCK_TENANT}`;

    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${overrideBase}/jobRequisitions`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );

    testClient = await createTestClient({
      env: { ...CONFIGURED_ENV, WORKDAY_RECRUITING_API_VERSION: 'v42.1' },
    });

    const result = await testClient.callTool('list_workday_job_requisitions', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(capturedUrl).toContain('/ccx/api/recruiting/v42.1/');
  });

  it('rejects a malformed WORKDAY_RECRUITING_API_VERSION and falls back', async () => {
    let capturedUrl: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${RECRUITING_API_BASE}/jobRequisitions`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );

    testClient = await createTestClient({
      env: { ...CONFIGURED_ENV, WORKDAY_RECRUITING_API_VERSION: '../../admin' },
    });

    const result = await testClient.callTool('list_workday_job_requisitions', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(capturedUrl).toContain('/ccx/api/recruiting/v41.2/');
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

    const result = await testClient.callTool('list_workday_job_requisitions', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });

  it('surfaces 403 when the ISU lacks recruiting permissions', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${RECRUITING_API_BASE}/jobRequisitions`, async () =>
        HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
      ),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_job_requisitions', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('FORBIDDEN');
  });
});
