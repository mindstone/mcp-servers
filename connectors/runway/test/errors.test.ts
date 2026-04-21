import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
