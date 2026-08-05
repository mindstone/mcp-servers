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
  PAYROLL_API_BASE,
  createTokenResponse,
} from './fixtures/workday-data.js';

const CONFIGURED_ENV = {
  WORKDAY_HOST: MOCK_HOST,
  WORKDAY_TENANT: MOCK_TENANT,
  WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
  WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
  MCP_HOST_BRIDGE_STATE: '',
};

const UNCONFIGURED_ENV = {
  WORKDAY_HOST: '',
  WORKDAY_TENANT: '',
  WORKDAY_CLIENT_ID: '',
  WORKDAY_CLIENT_SECRET: '',
  MCP_HOST_BRIDGE_STATE: '',
};

describe('list_workday_locations', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns locations with only allowed fields', async () => {
    mswServer.use(...createWorkdayHandlers());

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_locations', {});
    const json = result.json as {
      ok: boolean;
      locations: Array<Record<string, unknown>>;
      count: number;
      total: number;
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThan(0);
    const location = json.locations[0];
    expect(location.id).toBeDefined();
    expect(location.descriptor).toBeDefined();
    expect((location.locationType as Record<string, unknown>).descriptor).toBe('Office');
    // Free-text / sensitive fields are stripped by the allowlist
    expect(location.addressLine1).toBeUndefined();
    expect(location.addressNote).toBeUndefined();
    expect((location.locationType as Record<string, unknown>).internalCode).toBeUndefined();
  });

  it('passes pagination parameters correctly', async () => {
    let capturedLimit: string | null = null;
    let capturedOffset: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${API_BASE}/locations`, async ({ request }) => {
        const url = new URL(request.url);
        capturedLimit = url.searchParams.get('limit');
        capturedOffset = url.searchParams.get('offset');
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    await testClient.callTool('list_workday_locations', { limit: 25, offset: 50 });
    expect(capturedLimit).toBe('25');
    expect(capturedOffset).toBe('50');
  });

  it('returns not-configured error when credentials missing', async () => {
    testClient = await createTestClient({ env: UNCONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_locations', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });
});

describe('list_workday_jobs', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('returns jobs with only allowed fields', async () => {
    mswServer.use(...createWorkdayHandlers());

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_jobs', {});
    const json = result.json as {
      ok: boolean;
      jobs: Array<Record<string, unknown>>;
      count: number;
      total: number;
    };
    expect(json.ok).toBe(true);
    expect(json.count).toBeGreaterThan(0);
    const job = json.jobs[0];
    expect(job.id).toBeDefined();
    expect(job.businessTitle).toBeDefined();
    expect((job.worker as Record<string, unknown>).descriptor).toBe('Jane Smith');
    // Nested references are deep-picked: no PII or financials leak through
    expect((job.worker as Record<string, unknown>).ssn).toBeUndefined();
    expect((job.location as Record<string, unknown>).postalCode).toBeUndefined();
    expect((job.supervisoryOrganization as Record<string, unknown>).budget).toBeUndefined();
  });

  it('calls the payroll family endpoint', async () => {
    let capturedUrl: string | null = null;

    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${PAYROLL_API_BASE}/jobs`, async ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: [], total: 0 });
      }),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    await testClient.callTool('list_workday_jobs', { limit: 10 });
    expect(capturedUrl).toContain('/ccx/api/payroll/v2/');
    expect(capturedUrl).toContain('/jobs?');
    expect(capturedUrl).toContain('limit=10');
  });

  it('returns not-configured error when credentials missing', async () => {
    testClient = await createTestClient({ env: UNCONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_jobs', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('not configured');
  });

  it('surfaces a structured error when the API rejects the request', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () => HttpResponse.json(createTokenResponse())),
      http.get(`${PAYROLL_API_BASE}/jobs`, async () =>
        HttpResponse.json({ error: 'Forbidden' }, { status: 403 }),
      ),
    );

    testClient = await createTestClient({ env: CONFIGURED_ENV });

    const result = await testClient.callTool('list_workday_jobs', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('FORBIDDEN');
  });
});
