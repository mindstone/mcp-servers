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
  ABSENCE_API_BASE,
  createTokenResponse,
} from './fixtures/workday-data.js';

const CONFIGURED_ENV = {
  WORKDAY_HOST: MOCK_HOST,
  WORKDAY_TENANT: MOCK_TENANT,
  WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
  WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
  MCP_HOST_BRIDGE_STATE: '',
};

describe('list_workday_time_off', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns time-off entries with only allowed fields', async () => {
    mswServer.use(...createWorkdayHandlers());

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_time_off', { worker_id: 'worker-001' });
    const json = result.json as {
      ok: boolean;
      time_off: Array<Record<string, unknown>>;
      count: number;
      total: number;
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThan(0);
    const entry = json.time_off[0];
    expect(entry.id).toBeDefined();
    expect(entry.startDate).toBeDefined();
    expect(entry.endDate).toBeDefined();
    expect((entry.timeOffType as Record<string, unknown>).descriptor).toBeDefined();
    // Free-text and sensitive fields are stripped by the allowlist
    expect(entry.comment).toBeUndefined();
    expect(entry.reason).toBeUndefined();
    expect((entry.timeOffType as Record<string, unknown>).accrualRate).toBeUndefined();
  });

  it('calls the absenceManagement family endpoint', async () => {
    let capturedUrl: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${ABSENCE_API_BASE}/workers/:workerId/timeOffDetails`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    await testClient.callTool('list_workday_time_off', { worker_id: 'worker-001', limit: 25 });
    expect(capturedUrl).toContain('/ccx/api/absenceManagement/v1/');
    expect(capturedUrl).toContain('/workers/worker-001/timeOffDetails');
    expect(capturedUrl).toContain('limit=25');
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

    const result = await testClient.callTool('list_workday_time_off', { worker_id: 'worker-001' });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });

  it('surfaces 403 when the ISU lacks absence permissions', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${ABSENCE_API_BASE}/workers/:workerId/timeOffDetails`, async () =>
        HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
      ),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_time_off', { worker_id: 'worker-001' });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('FORBIDDEN');
  });
});
