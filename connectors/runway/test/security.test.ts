import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createRunwayHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

describe('Runway SSRF protection (download_runway_output)', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  const privateHosts = [
    { url: 'https://localhost/video.mp4', label: 'localhost' },
    { url: 'https://127.0.0.1/video.mp4', label: '127.0.0.1 (loopback)' },
    { url: 'https://10.0.0.1/video.mp4', label: '10.x (private class A)' },
    { url: 'https://10.255.255.255/video.mp4', label: '10.x upper bound' },
    { url: 'https://172.16.0.1/video.mp4', label: '172.16.x (private class B)' },
    { url: 'https://172.31.255.255/video.mp4', label: '172.31.x (private class B upper)' },
    { url: 'https://192.168.1.1/video.mp4', label: '192.168.x (private class C)' },
    { url: 'https://169.254.1.1/video.mp4', label: '169.254.x (link-local)' },
    { url: 'https://0.0.0.0/video.mp4', label: '0.0.0.0' },
    { url: 'https://[::1]/video.mp4', label: '::1 (IPv6 loopback)' },
    { url: 'https://myhost.local/video.mp4', label: '.local domain' },
  ];

  for (const { url, label } of privateHosts) {
    it(`blocks download from ${label}`, async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('download_runway_output', {
        url,
        output_path: '/tmp/test-output.mp4',
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.error).toContain('local/private network');
    });
  }

  it('rejects non-HTTPS URLs', async () => {
    mswServer.use(...createRunwayHandlers());
    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: 'http://example.com/video.mp4',
      output_path: '/tmp/test-output.mp4',
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('HTTPS');
  });

  it('rejects invalid URLs', async () => {
    mswServer.use(...createRunwayHandlers());
    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: 'not-a-url',
      output_path: '/tmp/test-output.mp4',
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Invalid URL');
  });
});
