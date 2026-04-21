import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mswServer } from './helpers/setup.js';
import {
  createNanoBananaHandlers,
  createNanoBananaUnauthorizedHandlers,
  createNanoBananaTimeoutHandlers,
  createNanoBananaBridgeHandlers,
  createNanoBananaBridge401Handlers,
  createNanoBananaBridge403Handlers,
  createNanoBananaBridgeFailureHandlers,
} from './helpers/nano-banana-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/nano-banana-data.js';

describe('Error handling', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('Authentication errors', () => {
    it('invalid credentials return isError without leaking secrets', async () => {
      mswServer.use(...createNanoBananaUnauthorizedHandlers());
      testClient = await createTestClient({
        env: { GEMINI_API_KEY: 'super-secret-gemini-key-12345', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('nano_banana_generate', {
        prompt: 'A test image',
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_FAILED');
      // Must not leak the API key
      expect(result.text).not.toContain('super-secret-gemini-key-12345');
    });

    it('no api key returns AUTH_REQUIRED', async () => {
      testClient = await createTestClient({
        env: { GEMINI_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('nano_banana_generate', {
        prompt: 'A test image',
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_REQUIRED');
    });
  });

  describe('Network timeout', () => {
    it('returns actionable error without secrets (uses NANO_BANANA_GEMINI_TIMEOUT_MS override)', async () => {
      mswServer.use(...createNanoBananaTimeoutHandlers());
      testClient = await createTestClient({
        env: {
          GEMINI_API_KEY: 'secret-timeout-key',
          MCP_HOST_BRIDGE_STATE: '',
          // Use a short timeout so the test fires fast; the default is 3 min.
          NANO_BANANA_GEMINI_TIMEOUT_MS: '500',
        },
      });

      const result = await testClient.callTool('nano_banana_generate', {
        prompt: 'A test image',
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('timed out');
      // Error message exposes the configured bound so the user can tune it.
      expect(result.text).toContain('NANO_BANANA_GEMINI_TIMEOUT_MS');
      // Must not leak the API key
      expect(result.text).not.toContain('secret-timeout-key');
    });

    it('ignores invalid NANO_BANANA_GEMINI_TIMEOUT_MS and falls back to default', async () => {
      testClient = await createTestClient({
        env: {
          GEMINI_API_KEY: '',
          MCP_HOST_BRIDGE_STATE: '',
          NANO_BANANA_GEMINI_TIMEOUT_MS: 'not-a-number',
        },
      });

      // Tool runs without throwing on the bad env var; falls back to the
      // AUTH_REQUIRED path, which proves the module loaded cleanly despite
      // the invalid config.
      const result = await testClient.callTool('nano_banana_generate', {
        prompt: 'A test image',
      });
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
    mswServer.use(...createNanoBananaHandlers());
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    // Before configure, tools should fail
    const beforeResult = await testClient.callTool('nano_banana_generate', {
      prompt: 'A test image',
    });
    expect(beforeResult.isError).toBe(true);

    // Configure
    const configResult = await testClient.callTool('configure_nano_banana_api_key', {
      api_key: MOCK_API_KEY,
    });
    expect(configResult.isError).toBeFalsy();
    expect(configResult.text).toContain('configured successfully');

    // After configure, tools should work
    const afterResult = await testClient.callTool('nano_banana_generate', {
      prompt: 'A test image',
    });
    expect(afterResult.isError).toBeFalsy();
  });

  it('rejects empty api_key via Zod before any request', async () => {
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('configure_nano_banana_api_key', {
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
    const tmpPath = path.join(os.tmpdir(), `nanobanana-bridge-test-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify({ port, token }), { mode: 0o600 });
    return tmpPath;
  }

  it('configure uses bridge when MCP_HOST_BRIDGE_STATE is set', async () => {
    const port = 19990;
    const token = 'test-bridge-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(
      ...createNanoBananaBridgeHandlers(port, token),
      ...createNanoBananaHandlers(),
    );

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_nano_banana_api_key', {
      api_key: 'new-api-key',
    });

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('configured successfully');
  });

  it('bridge 401 returns isError true', async () => {
    const port = 19991;
    bridgeStatePath = writeBridgeState(port, 'wrong-token');

    mswServer.use(...createNanoBananaBridge401Handlers(port));

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_nano_banana_api_key', {
      api_key: 'mcp-test-nano-banana-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('bridge 403 returns isError true', async () => {
    const port = 19992;
    bridgeStatePath = writeBridgeState(port, 'some-token');

    mswServer.use(...createNanoBananaBridge403Handlers(port));

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_nano_banana_api_key', {
      api_key: 'mcp-test-nano-banana-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('bridge { success: false } returns isError true (no silent fallback)', async () => {
    const port = 19993;
    const token = 'test-bridge-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(...createNanoBananaBridgeFailureHandlers(port, token));

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_nano_banana_api_key', {
      api_key: 'mcp-test-nano-banana-key',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('BRIDGE_ERROR');
  });

  it('configure uses MINDSTONE_REBEL_BRIDGE_STATE legacy env var', async () => {
    const port = 19994;
    const token = 'legacy-token';
    bridgeStatePath = writeBridgeState(port, token);

    mswServer.use(
      ...createNanoBananaBridgeHandlers(port, token),
      ...createNanoBananaHandlers(),
    );

    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: '',
        MINDSTONE_REBEL_BRIDGE_STATE: bridgeStatePath,
      },
    });

    const result = await testClient.callTool('configure_nano_banana_api_key', {
      api_key: 'new-api-key',
    });

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('configured successfully');
  });
});
