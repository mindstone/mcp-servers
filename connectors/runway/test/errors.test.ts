import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import {
  createRunwayHandlers,
  createRunwayUnauthorizedHandlers,
  createRunwayTimeoutHandlers,
  createRunwayBridgeHandlers,
  createRunwayBridge401Handlers,
  createRunwayBridge403Handlers,
  createRunwayBridgeFailureHandlers,
  createAuthCapturingHandlers,
} from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

describe('Error handling', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('Authentication errors', () => {
    it('invalid credentials return isError without leaking secrets', async () => {
      mswServer.use(...createRunwayUnauthorizedHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: 'super-secret-key-12345', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('get_runway_balance', {});

      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_FAILED');
      // Must not leak the API key
      expect(result.text).not.toContain('super-secret-key-12345');
    });

    it('no api key returns AUTH_REQUIRED', async () => {
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: '', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('get_runway_balance', {});

      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_REQUIRED');
    });
  });

  describe('Bearer + X-Runway-Version header format', () => {
    it('sends Authorization: Bearer and X-Runway-Version headers on API calls', async () => {
      const { handlers, capturedHeaders } = createAuthCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.callTool('get_runway_balance', {});

      expect(capturedHeaders.length).toBeGreaterThan(0);
      expect(capturedHeaders[0].authorization).toBe(`Bearer ${MOCK_API_KEY}`);
      expect(capturedHeaders[0].xRunwayVersion).toBe('2024-11-06');
    });
  });

  describe('Network timeout', () => {
    it('returns actionable error without secrets (uses RUNWAY_REQUEST_TIMEOUT_MS override)', async () => {
      mswServer.use(...createRunwayTimeoutHandlers());
      testClient = await createTestClient({
        env: {
          RUNWAYML_API_SECRET: 'secret-timeout-key',
          MCP_HOST_BRIDGE_STATE: '',
          // Short timeout so the test aborts fast; default is 60s.
          RUNWAY_REQUEST_TIMEOUT_MS: '500',
        },
      });

      const result = await testClient.callTool('get_runway_balance', {});

      expect(result.isError).toBe(true);
      expect(result.text).toContain('timed out');
      expect(result.text).toContain('RUNWAY_REQUEST_TIMEOUT_MS');
      // Must not leak the API key
      expect(result.text).not.toContain('secret-timeout-key');
    });

    it('ignores invalid RUNWAY_REQUEST_TIMEOUT_MS and falls back to default', async () => {
      testClient = await createTestClient({
        env: {
          RUNWAYML_API_SECRET: '',
          MCP_HOST_BRIDGE_STATE: '',
          RUNWAY_REQUEST_TIMEOUT_MS: 'not-a-number',
        },
      });

      // Module should load cleanly despite bad env; AUTH_REQUIRED proves it.
      const result = await testClient.callTool('get_runway_balance', {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_REQUIRED');
    });
  });
});

describe('Configure tool', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('configures API key and enables tools', async () => {
    mswServer.use(...createRunwayHandlers());
    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    // Before configure, tools should fail
    const beforeResult = await testClient.callTool('get_runway_balance', {});
    expect(beforeResult.isError).toBe(true);

    // Configure
    const configResult = await testClient.callTool('configure_runway_api_key', {
      api_key: MOCK_API_KEY,
    });
    expect(configResult.isError).toBeFalsy();
    expect(configResult.text).toContain('configured');

    // After configure, tools should work
    const afterResult = await testClient.callTool('get_runway_balance', {});
    expect(afterResult.isError).toBeFalsy();
  });

  it('rejects empty api_key via Zod before any request', async () => {
    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('configure_runway_api_key', {
      api_key: '',
    });

    expect(result.isError).toBe(true);
  });
});

describe('Bridge integration', () => {
  let testClient: McpTestClient;
  let bridgeStatePath: string;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    if (bridgeStatePath) {
      try { fs.unlinkSync(bridgeStatePath); } catch { /* ignore */ }
    }
  });

  function writeBridgeState(port: number, token: string): string {
    const tmpPath = path.join(os.tmpdir(), `runway-bridge-test-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify({ port, token }), { mode: 0o600 });
    return tmpPath;
  }

  it('configure uses bridge when MCP_HOST_BRIDGE_STATE is set', async () => {
    const port = 19990;
    const token = 'test-bridge-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(
      ...createRunwayBridgeHandlers(port, token),
      ...createRunwayHandlers(),
    );

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_runway_api_key', {
      api_key: 'new-api-key',
    });

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('configured');
  });

  it('bridge 401 returns isError true', async () => {
    const port = 19991;
    bridgeStatePath = writeBridgeState(port, 'wrong-token');

    mswServer.use(...createRunwayBridge401Handlers(port));

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_runway_api_key', {
      api_key: 'mcp-test-runway-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('bridge 403 returns isError true', async () => {
    const port = 19992;
    bridgeStatePath = writeBridgeState(port, 'some-token');

    mswServer.use(...createRunwayBridge403Handlers(port));

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_runway_api_key', {
      api_key: 'mcp-test-runway-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('bridge { success: false } returns isError true (no silent fallback)', async () => {
    const port = 19993;
    const token = 'test-bridge-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(...createRunwayBridgeFailureHandlers(port, token));

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_runway_api_key', {
      api_key: 'mcp-test-runway-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('configure uses MINDSTONE_REBEL_BRIDGE_STATE legacy env var', async () => {
    const port = 19994;
    const token = 'legacy-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(
      ...createRunwayBridgeHandlers(port, token),
      ...createRunwayHandlers(),
    );

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: '',
        MCP_HOST_BRIDGE_STATE: '',
        MINDSTONE_REBEL_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_runway_api_key', {
      api_key: 'new-api-key',
    });

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('configured');
  });
});

describe('Zod validation before outbound request', () => {
  let testClient: McpTestClient;
  let requestCount: number;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('configure rejects malformed input with no HTTP requests', async () => {
    requestCount = 0;
    const { http, HttpResponse } = await import('msw');
    mswServer.use(
      http.all('https://api.dev.runwayml.com/*', () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    // Missing required api_key field entirely
    const result = await testClient.callTool('configure_runway_api_key', {} as never);
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('generate_video_from_text rejects missing prompt with no HTTP requests', async () => {
    requestCount = 0;
    const { http, HttpResponse } = await import('msw');
    mswServer.use(
      http.all('https://api.dev.runwayml.com/*', () => {
        requestCount++;
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Missing required prompt_text field
    const result = await testClient.callTool('generate_video_from_text', {} as never);
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });
});

describe('Upload-leg timeout (uploadEphemeral signed-URL fetch)', () => {
  let testClient: McpTestClient;
  let tempFilePath: string;

  beforeEach(() => {
    // 1KB temp file — above the 512-byte floor, below the 200MB ceiling
    tempFilePath = path.join(os.tmpdir(), `runway-upload-timeout-${Date.now()}.bin`);
    fs.writeFileSync(tempFilePath, Buffer.alloc(1024, 0xab));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    vi.unstubAllEnvs();
  });

  it('upload stall aborts with TIMEOUT pointing at RUNWAY_UPLOAD_TIMEOUT_MS (uses override)', async () => {
    // Fast initial /uploads call to get the signed URL, then a stalled POST
    // to the signed URL triggers the upload-leg timeout.
    mswServer.use(
      ...createRunwayHandlers('secret-upload-key'),
      http.post('https://runway-uploads.example.com/upload', async () => {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: 'secret-upload-key',
        MCP_HOST_BRIDGE_STATE: '',
        // Short upload timeout so the test aborts fast; default is 10 min.
        RUNWAY_UPLOAD_TIMEOUT_MS: '500',
      },
    });

    const result = await testClient.callTool('upload_media', { file_path: tempFilePath });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('timed out');
    expect(result.text).toContain('TIMEOUT');
    expect(result.text).toContain('RUNWAY_UPLOAD_TIMEOUT_MS');
    // Must not leak the API key
    expect(result.text).not.toContain('secret-upload-key');
  });

  it('non-timeout upload failure (HTTP 500) is NOT misattributed as TIMEOUT', async () => {
    // Pins the attribution pattern: a real server-side error must surface
    // as UPLOAD_FAILED with the HTTP status, not be swallowed as TIMEOUT
    // just because the signal machinery is now in place.
    mswServer.use(
      ...createRunwayHandlers('secret-upload-key'),
      http.post('https://runway-uploads.example.com/upload', () =>
        HttpResponse.json({ error: 'Bucket unavailable' }, { status: 500 }),
      ),
    );

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: 'secret-upload-key',
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_UPLOAD_TIMEOUT_MS: '500',
      },
    });

    const result = await testClient.callTool('upload_media', { file_path: tempFilePath });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('UPLOAD_FAILED');
    expect(result.text).not.toContain('TIMEOUT');
    expect(result.text).not.toContain('timed out');
  });

  it('invalid RUNWAY_UPLOAD_TIMEOUT_MS falls back to default without breaking upload', async () => {
    // With valid auth + instant 204 from the signed URL, the upload should
    // complete successfully even though the env var is garbage — proving
    // getUploadTimeoutMs() returns the default rather than throwing.
    mswServer.use(
      ...createRunwayHandlers('secret-upload-key'),
      http.post('https://runway-uploads.example.com/upload', () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: 'secret-upload-key',
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_UPLOAD_TIMEOUT_MS: 'not-a-number',
      },
    });

    const result = await testClient.callTool('upload_media', { file_path: tempFilePath });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.text);
    expect(data.ok).toBe(true);
    expect(data.runway_uri).toBe('runway://test-upload-001');
  });
});
