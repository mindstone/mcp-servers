import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mswServer } from './helpers/setup.js';
import {
  createGammaHandlers,
  createGammaUnauthorizedHandlers,
  createGammaTimeoutHandlers,
  createGammaBridgeHandlers,
  createGammaBridge401Handlers,
  createGammaBridge403Handlers,
  createGammaBridgeFailureHandlers,
} from './helpers/gamma-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/gamma-data.js';

describe('Error handling', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('Authentication errors', () => {
    it('invalid credentials return isError without leaking secrets', async () => {
      mswServer.use(...createGammaUnauthorizedHandlers());
      testClient = await createTestClient({
        env: { GAMMA_API_KEY: 'super-secret-key-12345', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('gamma_list_themes', {});

      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_FAILED');
      // Must not leak the API key
      expect(result.text).not.toContain('super-secret-key-12345');
    });
  });

  describe('Network timeout', () => {
    it(
      'returns actionable error without secrets',
      async () => {
        mswServer.use(...createGammaTimeoutHandlers());
        testClient = await createTestClient({
          env: { GAMMA_API_KEY: 'secret-timeout-key', MCP_HOST_BRIDGE_STATE: '' },
        });

        const result = await testClient.callTool('gamma_list_themes', {});

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
    mswServer.use(...createGammaHandlers());
    testClient = await createTestClient({
      env: { GAMMA_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    // Before configure, tools should fail
    const beforeResult = await testClient.callTool('gamma_list_themes', {});
    expect(beforeResult.isError).toBe(true);

    // Configure
    const configResult = await testClient.callTool('configure_gamma_api_key', {
      api_key: MOCK_API_KEY,
    });
    expect(configResult.isError).toBeFalsy();
    expect(configResult.text).toContain('configured successfully');

    // After configure, tools should work
    const afterResult = await testClient.callTool('gamma_list_themes', {});
    expect(afterResult.isError).toBeFalsy();
  });

  it('rejects empty api_key via Zod before any request', async () => {
    testClient = await createTestClient({
      env: { GAMMA_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('configure_gamma_api_key', {
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
    const tmpPath = path.join(os.tmpdir(), `gamma-bridge-test-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify({ port, token }), { mode: 0o600 });
    return tmpPath;
  }

  it('configure uses bridge when MCP_HOST_BRIDGE_STATE is set', async () => {
    const port = 19876;
    const token = 'test-bridge-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(
      ...createGammaBridgeHandlers(port, token),
      ...createGammaHandlers(),
    );

    testClient = await createTestClient({
      env: {
        GAMMA_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_gamma_api_key', {
      api_key: 'new-api-key',
    });

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('configured successfully');
  });

  it('bridge 401 returns isError true', async () => {
    const port = 19877;
    bridgeStatePath = writeBridgeState(port, 'wrong-token');

    mswServer.use(...createGammaBridge401Handlers(port));

    testClient = await createTestClient({
      env: {
        GAMMA_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_gamma_api_key', {
      api_key: 'some-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('bridge 403 returns isError true', async () => {
    const port = 19878;
    bridgeStatePath = writeBridgeState(port, 'some-token');

    mswServer.use(...createGammaBridge403Handlers(port));

    testClient = await createTestClient({
      env: {
        GAMMA_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_gamma_api_key', {
      api_key: 'some-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('bridge { success: false } returns isError true (no silent fallback)', async () => {
    const port = 19879;
    const token = 'test-bridge-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(...createGammaBridgeFailureHandlers(port, token));

    testClient = await createTestClient({
      env: {
        GAMMA_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_gamma_api_key', {
      api_key: 'some-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('configure uses MINDSTONE_REBEL_BRIDGE_STATE legacy env var', async () => {
    const port = 19880;
    const token = 'legacy-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(
      ...createGammaBridgeHandlers(port, token),
      ...createGammaHandlers(),
    );

    testClient = await createTestClient({
      env: {
        GAMMA_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: '',
        MINDSTONE_REBEL_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_gamma_api_key', {
      api_key: 'new-api-key',
    });

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('configured successfully');
  });
});
