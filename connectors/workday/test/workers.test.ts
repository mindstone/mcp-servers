import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
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

describe('list_workday_workers', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns structured worker list with allowed fields', async () => {
    mswServer.use(...createWorkdayHandlers());

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.workers).toBeDefined();
    expect(Array.isArray(json.workers)).toBe(true);
    expect(json.count).toBeGreaterThan(0);
    expect(json.total).toBeDefined();
    expect(json.pagination).toBeDefined();
  });

  it('passes search parameter correctly', async () => {
    let capturedSearch: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/workers`, async ({ request }) => {
        const url = new URL(request.url);
        capturedSearch = url.searchParams.get('search');
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('list_workday_workers', { search: 'Jane Smith' });
    expect(capturedSearch).toBe('Jane Smith');
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

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });

  it('clamps limit to max 100', async () => {
    let capturedLimit: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/workers`, async ({ request }) => {
        const url = new URL(request.url);
        capturedLimit = url.searchParams.get('limit');
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    await testClient.callTool('list_workday_workers', { limit: 500 });
    expect(capturedLimit).toBe('100');
  });
});

describe('get_workday_worker', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns worker detail with only allowed fields', async () => {
    mswServer.use(...createWorkdayHandlers());

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('get_workday_worker', { worker_id: 'worker-001' });
    const json = result.json as { ok: boolean; worker: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.worker.id).toBe('worker-001');
    expect(json.worker.descriptor).toBeDefined();
    expect(json.worker.primaryWorkEmail).toBeDefined();
    expect(json.worker.businessTitle).toBeDefined();
  });

  it('handles 404 for non-existent worker', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/workers/:id`, async () =>
        HttpResponse.json({ error: 'Not found' }, { status: 404 }),
      ),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('get_workday_worker', { worker_id: 'nonexistent' });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('NOT_FOUND');
  });
});
