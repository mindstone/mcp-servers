/**
 * Fail-closed input validation coverage: malformed IDs and pagination values
 * must be rejected by the Zod schema before any outbound request, never
 * silently rewritten or forwarded to the network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import {
  MOCK_HOST,
  MOCK_TENANT,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  TOKEN_URL,
  API_BASE,
  createTokenResponse,
  createWorkersListResponse,
} from './fixtures/workday-data.js';

const CONFIGURED_ENV = {
  WORKDAY_HOST: MOCK_HOST,
  WORKDAY_TENANT: MOCK_TENANT,
  WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
  WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
  MCP_HOST_BRIDGE_STATE: '',
};

describe('fail-closed input validation', () => {
  let testClient: McpTestClient;
  let outboundRequestCount: number;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  function countOutbound() {
    outboundRequestCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, async () => {
        outboundRequestCount++;
        return HttpResponse.json(createTokenResponse());
      }),
      http.get(`${API_BASE}/workers`, async () => {
        outboundRequestCount++;
        return HttpResponse.json(createWorkersListResponse());
      }),
      http.get(`${API_BASE}/workers/:workerId`, async () => {
        outboundRequestCount++;
        return HttpResponse.json({});
      }),
      http.get(`${API_BASE}/workers/:workerId/directReports`, async () => {
        outboundRequestCount++;
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );
  }

  it('rejects an empty worker_id with zero outbound requests', async () => {
    countOutbound();
    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('get_workday_worker', { worker_id: '' });
    expect(result.isError).toBe(true);
    expect(outboundRequestCount).toBe(0);
  });

  it('rejects a whitespace-only worker_id with zero outbound requests', async () => {
    countOutbound();
    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_direct_reports', { worker_id: '   ' });
    expect(result.isError).toBe(true);
    expect(outboundRequestCount).toBe(0);
  });

  it('rejects a fractional limit with zero outbound requests', async () => {
    countOutbound();
    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_workers', { limit: 50.5 });
    expect(result.isError).toBe(true);
    expect(outboundRequestCount).toBe(0);
  });

  it('rejects a negative offset with zero outbound requests', async () => {
    countOutbound();
    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_direct_reports', {
      worker_id: 'worker-001',
      offset: -10,
    });
    expect(result.isError).toBe(true);
    expect(outboundRequestCount).toBe(0);
  });

  it('rejects a zero limit and an over-max limit', async () => {
    countOutbound();
    testClient = await createTestClient({ env: CONFIGURED_ENV });

    for (const limit of [0, 101]) {
      const result = await testClient.callTool('list_workday_workers', { limit });
      expect(result.isError).toBe(true);
    }
    expect(outboundRequestCount).toBe(0);
  });

  it('accepts valid pagination and forwards it', async () => {
    let capturedLimit: string | null = null;
    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${API_BASE}/workers`, async ({ request }) => {
        capturedLimit = new URL(request.url).searchParams.get('limit');
        return HttpResponse.json(createWorkersListResponse());
      }),
    );
    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_workers', { limit: 25, offset: 50 });
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(capturedLimit).toBe('25');
  });

  it('preserves a vendor-reported zero total (no || fallback rewrite)', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${API_BASE}/workers`, async () =>
        // Pathological but possible: vendor reports total 0 with data present.
        HttpResponse.json({ data: createWorkersListResponse(1, 0).data, total: 0 }),
      ),
    );
    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as { ok: boolean; total: number };
    expect(json.ok).toBe(true);
    expect(json.total).toBe(0);
  });
});
