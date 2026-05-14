import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createBridgeHandlers } from '@mindstone/mcp-test-harness';
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

describe('SSRF/private-host rejection', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  const privateHosts = [
    { host: 'localhost', label: 'localhost' },
    { host: '127.0.0.1', label: '127.0.0.1 (loopback)' },
    { host: '10.0.0.1', label: '10.x (private class A)' },
    { host: '172.16.0.1', label: '172.16.x (private class B)' },
    { host: '172.31.255.255', label: '172.31.x (private class B upper)' },
    { host: '192.168.1.1', label: '192.168.x (private class C)' },
    { host: '[::1]', label: '::1 (IPv6 loopback)' },
    { host: '169.254.1.1', label: '169.254.x (link-local)' },
    { host: '0.0.0.0', label: '0.0.0.0' },
  ];

  for (const { host, label } of privateHosts) {
    it(`rejects ${label}`, async () => {
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

      const result = await testClient.callTool('configure_workday_credentials', {
        host,
        tenant: MOCK_TENANT,
        client_id: MOCK_CLIENT_ID,
        client_secret: MOCK_CLIENT_SECRET,
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.error).toContain('localhost or a private IP');
    });
  }

  it('rejects host with protocol prefix (strips and validates)', async () => {
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

    const result = await testClient.callTool('configure_workday_credentials', {
      host: 'http://127.0.0.1',
      tenant: MOCK_TENANT,
      client_id: MOCK_CLIENT_ID,
      client_secret: MOCK_CLIENT_SECRET,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('localhost or a private IP');
  });
});

describe('Response field allowlisting', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('strips sensitive fields from worker detail response', async () => {
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

    const result = await testClient.callTool('get_workday_worker', {
      worker_id: 'worker-001',
    });

    const json = result.json as { ok: boolean; worker: Record<string, unknown> };
    expect(json.ok).toBe(true);

    const worker = json.worker;
    // Allowed fields should be present
    expect(worker.id).toBeDefined();
    expect(worker.descriptor).toBeDefined();
    expect(worker.primaryWorkEmail).toBeDefined();
    expect(worker.businessTitle).toBeDefined();

    // Sensitive fields must be stripped
    expect(worker.ssn).toBeUndefined();
    expect(worker.dateOfBirth).toBeUndefined();
    expect(worker.homeAddress).toBeUndefined();
    expect(worker.salary).toBeUndefined();

    // Nested objects should only have id + descriptor
    const location = worker.location as Record<string, unknown> | undefined;
    if (location) {
      expect(location.id).toBeDefined();
      expect(location.descriptor).toBeDefined();
      expect(location.address).toBeUndefined();
      expect(location.postalCode).toBeUndefined();
    }

    const supOrg = worker.supervisoryOrganization as Record<string, unknown> | undefined;
    if (supOrg) {
      expect(supOrg.id).toBeDefined();
      expect(supOrg.descriptor).toBeDefined();
      expect(supOrg.headcount).toBeUndefined();
      expect(supOrg.budget).toBeUndefined();
    }
  });

  it('strips sensitive fields from worker list response', async () => {
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
    const json = result.json as { ok: boolean; workers: Array<Record<string, unknown>> };
    expect(json.ok).toBe(true);

    for (const worker of json.workers) {
      // Only allowed fields
      expect(Object.keys(worker).every(k =>
        ['id', 'descriptor', 'primaryWorkEmail', 'businessTitle', 'isManager'].includes(k),
      )).toBe(true);
      // Sensitive fields stripped
      expect(worker.ssn).toBeUndefined();
      expect(worker.salary).toBeUndefined();
    }
  });

  it('strips sensitive fields from organizations list response', async () => {
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
    const json = result.json as { ok: boolean; organizations: Array<Record<string, unknown>> };
    expect(json.ok).toBe(true);

    for (const org of json.organizations) {
      expect(Object.keys(org).every(k =>
        ['id', 'descriptor', 'type', 'isActive', 'href'].includes(k),
      )).toBe(true);
      expect(org.budget).toBeUndefined();
      expect(org.headcount).toBeUndefined();
      expect(org.costCenter).toBeUndefined();
    }
  });
});

describe('Credential security', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('401 error does not leak client_secret or client_id', async () => {
    mswServer.use(
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(
          { error: 'invalid_client', error_description: 'Client authentication failed' },
          { status: 401 },
        ),
      ),
    );

    testClient = await createTestClient({
      env: {
        WORKDAY_HOST: MOCK_HOST,
        WORKDAY_TENANT: MOCK_TENANT,
        WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
        WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        WORKDAY_REFRESH_TOKEN: MOCK_HOST, // just a dummy
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('list_workday_workers', {});
    const text = result.text;
    expect(text).not.toContain(MOCK_CLIENT_SECRET);
    expect(text).not.toContain(MOCK_CLIENT_ID);
  });
});

describe('Malformed input rejection (Zod before outbound request)', () => {
  let testClient: McpTestClient;
  let outboundRequestCount: number;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('rejects configure_workday_credentials with missing required fields', async () => {
    outboundRequestCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, async () => {
        outboundRequestCount++;
        return HttpResponse.json(createTokenResponse());
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

    // Missing required fields triggers Zod validation
    const result = await testClient.callTool('configure_workday_credentials', {
      host: 'test.workday.com',
      // missing: tenant, client_id, client_secret
    });

    // Zod rejects before any outbound request
    expect(outboundRequestCount).toBe(0);
    // The MCP SDK returns an error for Zod validation failures
    expect(result.isError).toBe(true);
  });

  it('rejects get_workday_worker with missing worker_id', async () => {
    outboundRequestCount = 0;
    mswServer.use(
      http.post(TOKEN_URL, async () => {
        outboundRequestCount++;
        return HttpResponse.json(createTokenResponse());
      }),
      http.get(`${API_BASE}/workers/:id`, async () => {
        outboundRequestCount++;
        return HttpResponse.json({});
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

    const result = await testClient.callTool('get_workday_worker', {
      // missing: worker_id
    });

    expect(outboundRequestCount).toBe(0);
    expect(result.isError).toBe(true);
  });
});

describe('Bridge integration', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('bridge 401 returns isError:true with bridge-specific message', async () => {
    const bridgePort = 19876;

    // Use a handler that returns 401 for ALL bridge requests (no Bearer token check)
    mswServer.use(
      http.post(`http://127.0.0.1:${bridgePort}/bundled/workday/configure`, () =>
        HttpResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401 },
        ),
      ),
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/workers`, () =>
        HttpResponse.json({ data: [], total: 0 }),
      ),
    );

    // Create a temporary bridge state file
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-bridge-'));
    const bridgeStatePath = path.join(tmpDir, 'bridge-state.json');
    fs.writeFileSync(bridgeStatePath, JSON.stringify({ port: bridgePort, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          WORKDAY_HOST: MOCK_HOST,
          WORKDAY_TENANT: MOCK_TENANT,
          WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
          WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
          MCP_HOST_BRIDGE_STATE: bridgeStatePath,
        },
      });

      const result = await testClient.callTool('configure_workday_credentials', {
        host: MOCK_HOST,
        tenant: MOCK_TENANT,
        client_id: MOCK_CLIENT_ID,
        client_secret: MOCK_CLIENT_SECRET,
      });

      // Bridge failure must surface as isError:true MCP error, not just ok:false text
      expect(result.isError).toBe(true);
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('bridge { success: false } returns isError:true (not silent ok:false)', async () => {
    const bridgePort = 19878;

    mswServer.use(
      http.post(`http://127.0.0.1:${bridgePort}/bundled/workday/configure`, () =>
        HttpResponse.json({ success: false, error: 'Bridge internal failure' }),
      ),
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/workers`, () =>
        HttpResponse.json({ data: [], total: 0 }),
      ),
    );

    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-bridge-'));
    const bridgeStatePath = path.join(tmpDir, 'bridge-state.json');
    fs.writeFileSync(bridgeStatePath, JSON.stringify({ port: bridgePort, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          WORKDAY_HOST: MOCK_HOST,
          WORKDAY_TENANT: MOCK_TENANT,
          WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
          WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
          MCP_HOST_BRIDGE_STATE: bridgeStatePath,
        },
      });

      const result = await testClient.callTool('configure_workday_credentials', {
        host: MOCK_HOST,
        tenant: MOCK_TENANT,
        client_id: MOCK_CLIENT_ID,
        client_secret: MOCK_CLIENT_SECRET,
      });

      expect(result.isError).toBe(true);
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.code).toBe('BRIDGE_ERROR');
      expect(json.error).toContain('Bridge internal failure');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('bridge success configures credentials and returns ok', async () => {
    const bridgePort = 19877;

    mswServer.use(
      ...createBridgeHandlers(bridgePort),
      http.post(TOKEN_URL, async () =>
        HttpResponse.json(createTokenResponse()),
      ),
      http.get(`${API_BASE}/workers`, () =>
        HttpResponse.json({ data: [], total: 0 }),
      ),
    );

    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workday-bridge-'));
    const bridgeStatePath = path.join(tmpDir, 'bridge-state.json');
    fs.writeFileSync(bridgeStatePath, JSON.stringify({ port: bridgePort, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          WORKDAY_HOST: MOCK_HOST,
          WORKDAY_TENANT: MOCK_TENANT,
          WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
          WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
          MCP_HOST_BRIDGE_STATE: bridgeStatePath,
        },
      });

      const result = await testClient.callTool('configure_workday_credentials', {
        host: MOCK_HOST,
        tenant: MOCK_TENANT,
        client_id: MOCK_CLIENT_ID,
        client_secret: MOCK_CLIENT_SECRET,
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(json.message).toContain('configured successfully');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('WORKDAY_HOST env validation at startup', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  const privateEnvHosts = [
    { host: 'localhost', label: 'localhost' },
    { host: '127.0.0.1', label: '127.0.0.1' },
    { host: '10.0.0.1', label: '10.x private' },
    { host: '172.16.0.1', label: '172.16.x private' },
    { host: '192.168.1.1', label: '192.168.x private' },
    { host: '0.0.0.0', label: '0.0.0.0' },
  ];

  for (const { host, label } of privateEnvHosts) {
    it(`rejects private host ${label} from env var — connector reports not configured`, async () => {
      mswServer.use(
        ...createWorkdayHandlers(),
      );

      testClient = await createTestClient({
        env: {
          WORKDAY_HOST: host,
          WORKDAY_TENANT: MOCK_TENANT,
          WORKDAY_CLIENT_ID: MOCK_CLIENT_ID,
          WORKDAY_CLIENT_SECRET: MOCK_CLIENT_SECRET,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      // With an invalid host, the host is discarded (set to empty string),
      // so isConfigured() returns false and API calls report not configured
      const result = await testClient.callTool('list_workday_workers', {});
      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.error).toContain('not configured');
    });
  }

  it('accepts valid public host from env var', async () => {
    mswServer.use(
      ...createWorkdayHandlers(),
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

    const result = await testClient.callTool('list_workday_workers', {});
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });
});
