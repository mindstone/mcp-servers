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

describe('list_workday_organizations', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns structured organization list with allowed fields', async () => {
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

    const result = await testClient.callTool('list_workday_organizations', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.organizations).toBeDefined();
    expect(Array.isArray(json.organizations)).toBe(true);
    expect(json.count).toBeGreaterThan(0);
    expect(json.total).toBeDefined();
    expect(json.pagination).toBeDefined();
  });

  it('passes pagination parameters correctly', async () => {
    let capturedLimit: string | null = null;
    let capturedOffset: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/organizations`, async ({ request }) => {
        const url = new URL(request.url);
        capturedLimit = url.searchParams.get('limit');
        capturedOffset = url.searchParams.get('offset');
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

    await testClient.callTool('list_workday_organizations', { limit: 25, offset: 50 });
    expect(capturedLimit).toBe('25');
    expect(capturedOffset).toBe('50');
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

    const result = await testClient.callTool('list_workday_organizations', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });
});
