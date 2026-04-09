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
    expect(configJson.message).toContain('configured successfully');

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

      const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: 'some-key' });
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

      const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: 'some-key' });
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

      const result = await testClient.callTool('configure_pandadoc_api_key', { api_key: 'some-key' });
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
});
