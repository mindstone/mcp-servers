import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsHandlers,
  createElevenLabsUnauthorizedHandlers,
  createElevenLabsTimeoutHandlers,
  createElevenLabsBridgeHandlers,
  createElevenLabsBridge401Handlers,
  createElevenLabsBridge403Handlers,
  createElevenLabsBridgeFailureHandlers,
  createAuthCapturingHandlers,
} from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

describe('Error handling', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('Authentication errors', () => {
    it('invalid credentials return isError without leaking secrets', async () => {
      mswServer.use(...createElevenLabsUnauthorizedHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: 'super-secret-key-12345', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_voices', {});

      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_FAILED');
      // Must not leak the API key
      expect(result.text).not.toContain('super-secret-key-12345');
    });

    it('no api key returns AUTH_REQUIRED', async () => {
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_voices', {});

      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_REQUIRED');
    });
  });

  describe('xi-api-key header format', () => {
    it('sends xi-api-key header (NOT Bearer) on API calls', async () => {
      const { handlers, capturedHeaders } = createAuthCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.callTool('create_music_plan', {
        prompt: 'test music',
      });

      expect(capturedHeaders.length).toBeGreaterThan(0);
      expect(capturedHeaders[0].xiApiKey).toBe(MOCK_API_KEY);
    });
  });

  describe('Network timeout', () => {
    it(
      'returns actionable error without secrets',
      async () => {
        mswServer.use(...createElevenLabsTimeoutHandlers());
        testClient = await createTestClient({
          env: { ELEVENLABS_API_KEY: 'secret-timeout-key', MCP_HOST_BRIDGE_STATE: '' },
        });

        const result = await testClient.callTool('list_voices', {});

        expect(result.isError).toBe(true);
        expect(result.text).toContain('timed out');
        // Must not leak the API key
        expect(result.text).not.toContain('secret-timeout-key');
      },
      35_000,
    );
  });
});

describe('Configure tool', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('configures API key and enables tools', async () => {
    mswServer.use(...createElevenLabsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    // Before configure, tools should fail
    const beforeResult = await testClient.callTool('list_voices', {});
    expect(beforeResult.isError).toBe(true);

    // Configure
    const configResult = await testClient.callTool('configure_elevenlabs_api_key', {
      api_key: MOCK_API_KEY,
    });
    expect(configResult.isError).toBeFalsy();
    expect(configResult.text).toContain('configured successfully');

    // After configure, tools should work
    const afterResult = await testClient.callTool('list_voices', {});
    expect(afterResult.isError).toBeFalsy();
  });

  it('rejects empty api_key via Zod before any request', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('configure_elevenlabs_api_key', {
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
      try {
        fs.unlinkSync(bridgeStatePath);
      } catch { /* ignore */ }
    }
  });

  function writeBridgeState(port: number, token: string): string {
    const tmpPath = path.join(os.tmpdir(), `elevenlabs-bridge-test-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify({ port, token }), { mode: 0o600 });
    return tmpPath;
  }

  it('configure uses bridge when MCP_HOST_BRIDGE_STATE is set', async () => {
    const port = 19890;
    const token = 'test-bridge-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(
      ...createElevenLabsBridgeHandlers(port, token),
      ...createElevenLabsHandlers(),
    );

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_elevenlabs_api_key', {
      api_key: 'new-api-key',
    });

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('configured successfully');
  });

  it('bridge 401 returns isError true', async () => {
    const port = 19891;
    bridgeStatePath = writeBridgeState(port, 'wrong-token');

    mswServer.use(...createElevenLabsBridge401Handlers(port));

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_elevenlabs_api_key', {
      api_key: 'some-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('bridge 403 returns isError true', async () => {
    const port = 19892;
    bridgeStatePath = writeBridgeState(port, 'some-token');

    mswServer.use(...createElevenLabsBridge403Handlers(port));

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_elevenlabs_api_key', {
      api_key: 'some-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('bridge { success: false } returns isError true (no silent fallback)', async () => {
    const port = 19893;
    const token = 'test-bridge-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(...createElevenLabsBridgeFailureHandlers(port, token));

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_elevenlabs_api_key', {
      api_key: 'some-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('configure uses MINDSTONE_REBEL_BRIDGE_STATE legacy env var', async () => {
    const port = 19894;
    const token = 'legacy-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(
      ...createElevenLabsBridgeHandlers(port, token),
      ...createElevenLabsHandlers(),
    );

    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: '',
        MINDSTONE_REBEL_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_elevenlabs_api_key', {
      api_key: 'new-api-key',
    });

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('configured successfully');
  });
});
