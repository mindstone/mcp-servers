import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone/mcp-test-harness';

const BRIDGE_PORT = 47613;

describe('outreach_connect_account — bridge request throws', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('returns a fixed failure reply, never the exception text', async () => {
    tempConfig = createTempConfig({ empty: true });
    const bridgePath = path.join(tempConfig.configPath, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: BRIDGE_PORT, token: 'bridge-token' }), {
      mode: 0o600,
    });
    mswServer.use(
      http.post(`http://127.0.0.1:${BRIDGE_PORT}/mcp/configure`, () => HttpResponse.error()),
    );

    testClient = await createTestClient({
      env: {
        MCP_HOST_BRIDGE_STATE: bridgePath,
        MCP_BRIDGE_CONFIGURE_ENDPOINT: '',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
      },
    });

    const result = await testClient.callTool('outreach_connect_account', {});
    const json = result.json as { ok: boolean; error: string; action_required: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('Bridge request failed');
    expect(json.action_required).toMatch(/host app is running/);
    expect(result.text).not.toMatch(/fetch|TypeError|Network/i);
  });
});
