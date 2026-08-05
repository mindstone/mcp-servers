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
  createWorker,
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

  it('filters search results client-side without forwarding a search param', async () => {
    let forwardedSearch: string | null = null;
    const seenOffsets: string[] = [];

    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/workers`, async ({ request }) => {
        const url = new URL(request.url);
        forwardedSearch = url.searchParams.get('search');
        seenOffsets.push(url.searchParams.get('offset') ?? '');
        return HttpResponse.json({
          data: [
            createWorker({ id: 'w-1', descriptor: 'Jane Smith', primaryWorkEmail: 'jane.smith@acme.com' }),
            createWorker({ id: 'w-2', descriptor: 'John Doe', primaryWorkEmail: 'john.doe@acme.com' }),
            createWorker({ id: 'w-3', descriptor: 'Janet Van Dyne', primaryWorkEmail: 'janet@acme.com' }),
          ],
          total: 3,
        });
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

    const result = await testClient.callTool('list_workday_workers', { search: 'jane smith' });
    const json = result.json as {
      ok: boolean;
      workers: Array<{ id: string }>;
      total: number;
      search: { mode: string; scannedWorkers: number };
    };
    expect(json.ok).toBe(true);
    expect(json.workers.map((w) => w.id)).toEqual(['w-1']);
    expect(json.total).toBe(1);
    expect(json.search.mode).toBe('client-side');
    expect(json.search.scannedWorkers).toBe(3);
    // The Workday /workers collection documents only limit/offset — the search
    // term must not be forwarded as a (silently ignored) query param.
    expect(forwardedSearch).toBeNull();
    expect(seenOffsets).toEqual(['0']);
  });

  it('matches search case-insensitively across name, email, and title', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/workers`, async () =>
        HttpResponse.json({
          data: [
            createWorker({ id: 'w-1', descriptor: 'Jane Smith', businessTitle: 'Staff Engineer' }),
            createWorker({ id: 'w-2', descriptor: 'John Doe', primaryWorkEmail: 'engineer.john@acme.com' }),
            createWorker({ id: 'w-3', descriptor: 'Bob Ross', businessTitle: 'Designer' }),
          ],
          total: 3,
        }),
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

    const result = await testClient.callTool('list_workday_workers', { search: 'ENGINEER' });
    const json = result.json as { ok: boolean; workers: Array<{ id: string }> };
    expect(json.ok).toBe(true);
    expect(json.workers.map((w) => w.id)).toEqual(['w-1', 'w-2']);
  });

  it('flags when the client-side scan limit is reached', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/workers`, async ({ request }) => {
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        // Always return a full page and advertise a huge total so the
        // connector keeps paging until it hits its own scan cap.
        const data = Array.from({ length: 100 }, (_, i) =>
          createWorker({ id: `w-${offset + i}`, descriptor: `Worker ${offset + i}` }),
        );
        return HttpResponse.json({ data, total: 100000 });
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

    const result = await testClient.callTool('list_workday_workers', { search: 'no-such-person' });
    const json = result.json as {
      ok: boolean;
      total: number;
      search: { scannedWorkers: number; scanLimitReached?: boolean };
    };
    expect(json.ok).toBe(true);
    expect(json.total).toBe(0);
    expect(json.search.scannedWorkers).toBe(1000);
    expect(json.search.scanLimitReached).toBe(true);
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

  it('rejects an over-max limit rather than silently clamping it', async () => {
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

    const result = await testClient.callTool('list_workday_workers', { limit: 500 });
    // Fail-closed: the schema rejects over-max input before any request.
    expect(result.isError).toBe(true);
    expect(capturedLimit).toBeNull();
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
