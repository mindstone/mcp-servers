import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createPandaDocHandlers } from './helpers/pandadoc-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('PandaDoc configure tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('configure_pandadoc_api_key sets the key and enables subsequent calls', async () => {
    const NEW_KEY = 'newly-configured-key';

    // Start without API key, with handlers that accept the new key
    mswServer.use(...createPandaDocHandlers(NEW_KEY));

    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    // First, verify calls fail without key
    const beforeResult = await testClient.callTool('list_documents', {});
    const beforeJson = beforeResult.json as { ok: boolean; error: string };
    expect(beforeJson.ok).toBe(false);
    expect(beforeJson.error).toContain('not configured');

    // Configure the key
    const configResult = await testClient.callTool('configure_pandadoc_api_key', { api_key: NEW_KEY });
    const configJson = configResult.json as { ok: boolean; message: string };
    expect(configJson.ok).toBe(true);
    expect(configJson.message).toContain('only until the app restarts');

    // Now list documents should work
    const afterResult = await testClient.callTool('list_documents', {});
    const afterJson = afterResult.json as { ok: boolean; documents: unknown[] };
    expect(afterJson.ok).toBe(true);
    expect(afterJson.documents).toBeDefined();
  });

  it('configure_pandadoc_api_key rejects empty key via Zod (requestCount=0)', async () => {
    let requestCount = 0;
    mswServer.use(
      ...createPandaDocHandlers(),
      http.post('http://127.0.0.1:9999/bundled/pandadoc/configure', () => {
        requestCount++;
        return HttpResponse.json({ success: true });
      }),
    );
    testClient = await createTestClient({
      env: { PANDADOC_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: '' });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('configure_pandadoc_api_key returns isError when bridge returns 401', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/pandadoc/configure', () => {
        return new HttpResponse(null, { status: 401 });
      }),
      ...createPandaDocHandlers(),
    );

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandadoc-bridge-401-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          PANDADOC_API_KEY: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: 'mcp-test-pandadoc-key' });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; error: string; code: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('401');
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('configure_pandadoc_api_key returns isError when bridge returns 403', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/pandadoc/configure', () => {
        return new HttpResponse(null, { status: 403 });
      }),
      ...createPandaDocHandlers(),
    );

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandadoc-bridge-403-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          PANDADOC_API_KEY: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: 'mcp-test-pandadoc-key' });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; error: string; code: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('403');
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('configure_pandadoc_api_key returns isError when bridge returns success:false', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/pandadoc/configure', () => {
        return HttpResponse.json({ success: false, error: 'Invalid API key format' });
      }),
      ...createPandaDocHandlers(),
    );

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandadoc-bridge-fail-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          PANDADOC_API_KEY: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: 'mcp-test-pandadoc-key' });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; error: string; code: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('Invalid API key format');
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('configure_pandadoc_api_key works with bridge available', async () => {
    // Mock bridge endpoint
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/pandadoc/configure', async ({ request }) => {
        const body = await request.json() as { apiKey: string };
        if (body.apiKey) {
          return HttpResponse.json({ success: true });
        }
        return HttpResponse.json({ success: false, error: 'Missing key' });
      }),
      ...createPandaDocHandlers('bridge-key'),
    );

    // Write a temp bridge state file
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandadoc-bridge-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          PANDADOC_API_KEY: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: 'bridge-key' });
      const json = result.json as { ok: boolean; message: string };
      expect(json.ok).toBe(true);
      expect(json.message).toContain('configured successfully');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Hardened bridge reader: unusable state falls back to session-only ──

  async function withBridgeDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
      return await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function countBridgeRequests(): { count: number } {
    const counter = { count: 0 };
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/pandadoc/configure', () => {
        counter.count++;
        return HttpResponse.json({ success: true });
      }),
      ...createPandaDocHandlers('session-key'),
    );
    return counter;
  }

  async function expectSessionOnly(env: Record<string, string>, counter: { count: number }): Promise<void> {
    testClient = await createTestClient({ env: { PANDADOC_API_KEY: '', ...env } });
    const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: 'session-key' });
    expect(result.isError).toBeFalsy();
    const json = result.json as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toContain('only until the app restarts');
    expect(json.message).toContain('could not save it');
    expect(counter.count).toBe(0);
    // The key really is set for this session.
    const list = await testClient.callTool('list_documents', {});
    expect((list.json as { ok: boolean }).ok).toBe(true);
  }

  it('configure_pandadoc_api_key keeps the key for the session when no bridge is configured', async () => {
    const counter = countBridgeRequests();
    await expectSessionOnly({ MCP_HOST_BRIDGE_STATE: '', MINDSTONE_REBEL_BRIDGE_STATE: '' }, counter);
  });

  it.skipIf(process.platform === 'win32')(
    'configure_pandadoc_api_key refuses a symlinked bridge state file and never contacts the bridge',
    async () => {
      const counter = countBridgeRequests();
      await withBridgeDir('pandadoc-bridge-symlink-', async (dir) => {
        const fs = await import('fs');
        const path = await import('path');
        const real = path.join(dir, 'real.json');
        const link = path.join(dir, 'bridge.json');
        fs.writeFileSync(real, JSON.stringify({ port: 9999, token: 'test-token' }));
        fs.symlinkSync(real, link);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          await expectSessionOnly({ MCP_HOST_BRIDGE_STATE: link }, counter);
          expect(errSpy).toHaveBeenCalledWith('[pandadoc] bridge state rejected: state path is a symbolic link');
        } finally {
          errSpy.mockRestore();
        }
      });
    },
  );

  it('configure_pandadoc_api_key refuses bridge state with an invalid port and never contacts the bridge', async () => {
    const counter = countBridgeRequests();
    await withBridgeDir('pandadoc-bridge-port0-', async (dir) => {
      const fs = await import('fs');
      const path = await import('path');
      const statePath = path.join(dir, 'bridge.json');
      fs.writeFileSync(statePath, JSON.stringify({ port: 0, token: 'test-token' }));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expectSessionOnly({ MCP_HOST_BRIDGE_STATE: statePath }, counter);
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  it('configure_pandadoc_api_key refuses non-JSON bridge state and never contacts the bridge', async () => {
    const counter = countBridgeRequests();
    await withBridgeDir('pandadoc-bridge-nonjson-', async (dir) => {
      const fs = await import('fs');
      const path = await import('path');
      const statePath = path.join(dir, 'bridge.json');
      fs.writeFileSync(statePath, 'not json at all');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expectSessionOnly({ MCP_HOST_BRIDGE_STATE: statePath }, counter);
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  it('configure_pandadoc_api_key returns BRIDGE_ERROR when the bridge reply has the wrong shape', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/pandadoc/configure', () => {
        return HttpResponse.json({ success: 'yes' });
      }),
      ...createPandaDocHandlers(),
    );
    await withBridgeDir('pandadoc-bridge-shape-', async (dir) => {
      const fs = await import('fs');
      const path = await import('path');
      const statePath = path.join(dir, 'bridge.json');
      fs.writeFileSync(statePath, JSON.stringify({ port: 9999, token: 'test-token' }));
      testClient = await createTestClient({ env: { PANDADOC_API_KEY: '', MCP_HOST_BRIDGE_STATE: statePath } });
      const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: 'mcp-test-pandadoc-key' });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; error: string; code: string };
      expect(json.ok).toBe(false);
      expect(json.code).toBe('BRIDGE_ERROR');
      expect(json.error).toContain('unexpected response shape');
    });
  });

  it('configure_pandadoc_api_key does not treat a bridge-authored "Bridge not available" as session-only', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/pandadoc/configure', () => {
        return HttpResponse.json({ success: false, error: 'Bridge not available' });
      }),
      ...createPandaDocHandlers(),
    );
    await withBridgeDir('pandadoc-bridge-spoof-', async (dir) => {
      const fs = await import('fs');
      const path = await import('path');
      const statePath = path.join(dir, 'bridge.json');
      fs.writeFileSync(statePath, JSON.stringify({ port: 9999, token: 'test-token' }));
      testClient = await createTestClient({ env: { PANDADOC_API_KEY: '', MCP_HOST_BRIDGE_STATE: statePath } });
      const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: 'mcp-test-pandadoc-key' });
      expect(result.isError).toBe(true);
      expect((result.json as { code: string }).code).toBe('BRIDGE_ERROR');
    });
  });
  it.each([
    ['error', { success: false, error: 'Invalid key: echo-secret-key-123' }],
    ['warning', { success: true, warning: 'Saved echo-secret-key-123 to keychain' }],
  ])('configure_pandadoc_api_key never echoes the submitted key in a bridge %s', async (_kind, reply) => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/pandadoc/configure', () => HttpResponse.json(reply)),
      ...createPandaDocHandlers(),
    );
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandadoc-bridge-echo-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));
    try {
      testClient = await createTestClient({
        env: { PANDADOC_API_KEY: '', MINDSTONE_REBEL_BRIDGE_STATE: bridgePath, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: 'echo-secret-key-123' });
      const text = JSON.stringify(result.json);
      expect(text).not.toContain('echo-secret-key-123');
      expect(text).toContain('[redacted]');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
