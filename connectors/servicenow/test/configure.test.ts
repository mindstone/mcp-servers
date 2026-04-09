import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createServiceNowHandlers } from './helpers/servicenow-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('ServiceNow configure tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('configure_servicenow sets credentials and enables subsequent calls', async () => {
    // Start handlers that accept the new credentials
    mswServer.use(...createServiceNowHandlers('new-user', 'new-pass'));

    testClient = await createTestClient({
      env: {
        SERVICENOW_INSTANCE: '',
        SERVICENOW_USERNAME: '',
        SERVICENOW_PASSWORD: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    // First, verify calls fail without credentials
    const beforeResult = await testClient.callTool('list_servicenow_incidents', {});
    const beforeJson = beforeResult.json as { ok: boolean; error: string };
    expect(beforeJson.ok).toBe(false);

    // Configure the credentials
    const configResult = await testClient.callTool('configure_servicenow', {
      instance: 'test-instance',
      username: 'new-user',
      password: 'new-pass',
    });
    const configJson = configResult.json as { ok: boolean; message: string };
    expect(configJson.ok).toBe(true);
    expect(configJson.message).toContain('configured successfully');
    expect(configJson.message).toContain('test-instance.service-now.com');

    // Now list incidents should work
    const afterResult = await testClient.callTool('list_servicenow_incidents', {});
    const afterJson = afterResult.json as { ok: boolean; incidents: unknown[] };
    expect(afterJson.ok).toBe(true);
    expect(afterJson.incidents).toBeDefined();
  });

  it('configure_servicenow rejects empty instance via Zod', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({
      env: {
        SERVICENOW_INSTANCE: '',
        SERVICENOW_USERNAME: '',
        SERVICENOW_PASSWORD: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_servicenow', {
      instance: '',
      username: 'user',
      password: 'pass',
    });
    expect(result.isError).toBe(true);
  });

  it('configure_servicenow rejects invalid instance format', async () => {
    mswServer.use(...createServiceNowHandlers());
    testClient = await createTestClient({
      env: {
        SERVICENOW_INSTANCE: '',
        SERVICENOW_USERNAME: '',
        SERVICENOW_PASSWORD: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_servicenow', {
      instance: 'invalid..instance',
      username: 'user',
      password: 'pass',
    });
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Invalid instance');
  });

  it('configure_servicenow accepts full URL format', async () => {
    mswServer.use(...createServiceNowHandlers('user', 'pass'));
    testClient = await createTestClient({
      env: {
        SERVICENOW_INSTANCE: '',
        SERVICENOW_USERNAME: '',
        SERVICENOW_PASSWORD: '',
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.callTool('configure_servicenow', {
      instance: 'https://test-instance.service-now.com',
      username: 'user',
      password: 'pass',
    });
    const json = result.json as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toContain('test-instance.service-now.com');
  });

  it('configure_servicenow returns isError when bridge returns 401', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/servicenow/configure', () => {
        return new HttpResponse(null, { status: 401 });
      }),
      ...createServiceNowHandlers(),
    );

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'servicenow-bridge-401-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          SERVICENOW_INSTANCE: '',
          SERVICENOW_USERNAME: '',
          SERVICENOW_PASSWORD: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_servicenow', {
        instance: 'test-instance',
        username: 'user',
        password: 'pass',
      });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; error: string; code: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('401');
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('configure_servicenow returns isError when bridge returns 403', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/servicenow/configure', () => {
        return new HttpResponse(null, { status: 403 });
      }),
      ...createServiceNowHandlers(),
    );

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'servicenow-bridge-403-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          SERVICENOW_INSTANCE: '',
          SERVICENOW_USERNAME: '',
          SERVICENOW_PASSWORD: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_servicenow', {
        instance: 'test-instance',
        username: 'user',
        password: 'pass',
      });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; error: string; code: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('403');
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('configure_servicenow returns isError when bridge returns success:false', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/servicenow/configure', () => {
        return HttpResponse.json({ success: false, error: 'Invalid credentials' });
      }),
      ...createServiceNowHandlers(),
    );

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'servicenow-bridge-fail-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          SERVICENOW_INSTANCE: '',
          SERVICENOW_USERNAME: '',
          SERVICENOW_PASSWORD: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_servicenow', {
        instance: 'test-instance',
        username: 'user',
        password: 'pass',
      });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; error: string; code: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('Invalid credentials');
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('configure_servicenow works with bridge available', async () => {
    // Mock bridge endpoint
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/servicenow/configure', async ({ request }) => {
        const body = (await request.json()) as { instance: string; username: string; password: string };
        if (body.instance && body.username && body.password) {
          return HttpResponse.json({ success: true });
        }
        return HttpResponse.json({ success: false, error: 'Missing credentials' });
      }),
      ...createServiceNowHandlers('bridge-user', 'bridge-pass'),
    );

    // Write a temp bridge state file
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'servicenow-bridge-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          SERVICENOW_INSTANCE: '',
          SERVICENOW_USERNAME: '',
          SERVICENOW_PASSWORD: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_servicenow', {
        instance: 'test-instance',
        username: 'bridge-user',
        password: 'bridge-pass',
      });
      const json = result.json as { ok: boolean; message: string };
      expect(json.ok).toBe(true);
      expect(json.message).toContain('configured successfully');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
