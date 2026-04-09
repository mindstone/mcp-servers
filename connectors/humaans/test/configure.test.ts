import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createHumaansHandlers } from './helpers/humaans-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

describe('Humaans configure tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('configure_humaans_api_key sets the key and enables subsequent calls', async () => {
    const NEW_KEY = 'newly-configured-key';

    // Start without API key, with handlers that accept the new key
    mswServer.use(...createHumaansHandlers(NEW_KEY));

    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    // First, verify calls fail without key
    const beforeResult = await testClient.callTool('list_humaans_people', {});
    const beforeJson = beforeResult.json as { ok: boolean; error: string };
    expect(beforeJson.ok).toBe(false);
    expect(beforeJson.error).toContain('not configured');

    // Configure the key
    const configResult = await testClient.callTool('configure_humaans_api_key', { api_key: NEW_KEY });
    const configJson = configResult.json as { ok: boolean; message: string };
    expect(configJson.ok).toBe(true);
    expect(configJson.message).toContain('configured successfully');

    // Now list people should work
    const afterResult = await testClient.callTool('list_humaans_people', {});
    const afterJson = afterResult.json as { ok: boolean; people: unknown[] };
    expect(afterJson.ok).toBe(true);
    expect(afterJson.people).toBeDefined();
  });

  it('configure_humaans_api_key rejects empty key via Zod', async () => {
    mswServer.use(...createHumaansHandlers());
    testClient = await createTestClient({
      env: { HUMAANS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('configure_humaans_api_key', { api_key: '' });
    expect(result.isError).toBe(true);
  });

  it('configure_humaans_api_key works with bridge available', async () => {
    // Mock bridge endpoint
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/humaans/configure', async ({ request }) => {
        const body = await request.json() as { apiKey: string };
        if (body.apiKey) {
          return HttpResponse.json({ success: true });
        }
        return HttpResponse.json({ success: false, error: 'Missing key' });
      }),
      ...createHumaansHandlers('bridge-key'),
    );

    // Write a temp bridge state file
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'humaans-bridge-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          HUMAANS_API_KEY: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_humaans_api_key', { api_key: 'bridge-key' });
      const json = result.json as { ok: boolean; message: string };
      expect(json.ok).toBe(true);
      expect(json.message).toContain('configured successfully');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
