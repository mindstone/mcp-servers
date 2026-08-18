/**
 * Bridge timeout budget regression tests.
 *
 * `bridgeRequest` used to abort EVERY call at REQUEST_TIMEOUT_MS (30s). The
 * OAuth-initiating configure call triggers a host-side interactive OAuth flow
 * whose own budget is 5 minutes, so the 30s abort guaranteed a spurious
 * failure on any human-paced connect. Contract under test:
 *
 * 1. Ordinary bridge calls keep the default 30s budget.
 * 2. Only the OAuth-initiating configure call opts into the long
 *    BRIDGE_OAUTH_TIMEOUT_MS budget.
 * 3. The abort is never removed — every fetch still carries an AbortSignal,
 *    so a genuinely dead bridge fails within the chosen bound.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { mswServer } from './helpers/setup.js';
import { http, HttpResponse } from 'msw';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';

/**
 * bridge.ts captures MCP_HOST_BRIDGE_STATE at import time, so each unit test
 * stubs the env var and re-imports the module fresh (mirrors the outreach
 * connector's bridge tests).
 */
async function importBridge(): Promise<{
  bridgeRequest: (
    urlPath: string,
    body?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<{ success: boolean; error?: string; username?: string }>;
  REQUEST_TIMEOUT_MS: number;
  BRIDGE_OAUTH_TIMEOUT_MS: number;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salesforce-bridge-test-'));
  const statePath = path.join(dir, 'bridge.json');
  fs.writeFileSync(statePath, JSON.stringify({ port: 9999, token: 'bridge-token' }), { mode: 0o600 });
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', statePath);
  vi.resetModules();
  const { bridgeRequest } = await import('../src/bridge.js');
  const { REQUEST_TIMEOUT_MS, BRIDGE_OAUTH_TIMEOUT_MS } = await import('../src/types.js');
  return { bridgeRequest, REQUEST_TIMEOUT_MS, BRIDGE_OAUTH_TIMEOUT_MS };
}

describe('bridgeRequest timeout budget', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('pins the budget constants: 30s default, long-but-bounded OAuth budget', async () => {
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.resetModules();
    const { REQUEST_TIMEOUT_MS, BRIDGE_OAUTH_TIMEOUT_MS } = await import('../src/types.js');

    // Ordinary calls: unchanged 30s budget.
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    // OAuth budget: at least the 5-minute host-side flow budget, but still
    // bounded (not unbounded — a dead bridge must eventually fail).
    expect(BRIDGE_OAUTH_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(BRIDGE_OAUTH_TIMEOUT_MS).toBeLessThan(10 * 60 * 1000);
  });

  it('defaults to the ordinary 30s budget for calls with no explicit timeout', async () => {
    const { bridgeRequest } = await importBridge();
    const fetchSpy = vi.fn().mockResolvedValue({
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await bridgeRequest('/mcp/status');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The ordinary default must remain exactly 30s.
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    // The abort is still wired: every bridge fetch carries a signal.
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the long OAuth budget only when the caller passes it', async () => {
    const { bridgeRequest, BRIDGE_OAUTH_TIMEOUT_MS } = await importBridge();
    const fetchSpy = vi.fn().mockResolvedValue({
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await bridgeRequest('/mcp/configure', {}, BRIDGE_OAUTH_TIMEOUT_MS);

    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(BRIDGE_OAUTH_TIMEOUT_MS);
    expect(timeoutSpy).not.toHaveBeenCalledWith(30_000);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('salesforce_connect_account bridge-mode timeout (integration)', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function setupBridgeClient(): Promise<void> {
    tempConfig = createTempConfig({ empty: true });
    const bridgePath = path.join(tempConfig.configPath, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test' }));
    testClient = await createTestClient({
      env: {
        MCP_HOST_BRIDGE_STATE: bridgePath,
        SALESFORCE_CLIENT_ID: 'mcp-test-client-id',
        SALESFORCE_CLIENT_SECRET: 'mcp-test-client-secret',
        SALESFORCE_CONFIG_DIR: tempConfig.configPath,
      },
    });
  }

  it('gives the configure call the long OAuth budget, not the 30s default', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/mcp/configure', () =>
        HttpResponse.json({ success: true, username: 'jane@example.com' }),
      ),
    );
    await setupBridgeClient();
    const { BRIDGE_OAUTH_TIMEOUT_MS } = await import('../src/types.js');
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    const result = await testClient.callTool('salesforce_connect_account', {});

    expect(result.json).toHaveProperty('ok', true);
    expect(timeoutSpy).toHaveBeenCalledWith(BRIDGE_OAUTH_TIMEOUT_MS);
    // And never the ordinary default for the configure request.
    expect(timeoutSpy).not.toHaveBeenCalledWith(30_000);
  });
});
