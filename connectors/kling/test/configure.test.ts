import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createKlingHandlers } from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-at-least-32-chars-long';

describe('Kling configure tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('configure_kling_api_keys sets keys and enables subsequent calls', async () => {
    mswServer.use(...createKlingHandlers());

    // Start without API keys
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: '', KLING_SECRET_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    // Verify calls fail without keys
    const beforeResult = await testClient.callTool('generate_kling_video', { prompt: 'test' });
    const beforeJson = beforeResult.json as { ok: boolean; error: string };
    expect(beforeJson.ok).toBe(false);
    expect(beforeJson.error).toContain('not configured');

    // Configure the keys
    const configResult = await testClient.callTool('configure_kling_api_keys', {
      access_key: ACCESS_KEY,
      secret_key: SECRET_KEY,
    });
    const configJson = configResult.json as { ok: boolean; message: string };
    expect(configJson.ok).toBe(true);
    expect(configJson.message).toContain('configured successfully');

    // Now video generation should work
    const afterResult = await testClient.callTool('generate_kling_video', { prompt: 'test' });
    const afterJson = afterResult.json as { ok: boolean; task_id: string };
    expect(afterJson.ok).toBe(true);
    expect(afterJson.task_id).toBeDefined();
  });

  it('configure_kling_api_keys rejects empty keys via Zod', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: '', KLING_SECRET_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('configure_kling_api_keys', {
      access_key: '',
      secret_key: '',
    });
    expect(result.isError).toBe(true);
  });

  it('configure_kling_api_keys works with bridge available', async () => {
    // Mock bridge endpoint
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/kling/configure', async ({ request }) => {
        const body = (await request.json()) as { accessKey: string; secretKey: string };
        if (body.accessKey && body.secretKey) {
          return HttpResponse.json({ success: true });
        }
        return HttpResponse.json({ success: false, error: 'Missing keys' });
      }),
      ...createKlingHandlers(),
    );

    // Write a temp bridge state file
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-bridge-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          KLING_ACCESS_KEY: '',
          KLING_SECRET_KEY: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_kling_api_keys', {
        access_key: ACCESS_KEY,
        secret_key: SECRET_KEY,
      });
      const json = result.json as { ok: boolean; message: string };
      expect(json.ok).toBe(true);
      expect(json.message).toContain('configured successfully');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
