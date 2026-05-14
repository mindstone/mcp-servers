import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTalentLMSHandlers } from './helpers/talentlms-mock-server.js';
import { createBridgeHandlers } from '@mindstone/mcp-test-harness';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, MOCK_DOMAIN } from './fixtures/talentlms-data.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Bridge integration', () => {
  let testClient: McpTestClient | undefined;
  let tmpDir: string;

  beforeEach(() => {
    mswServer.use(...createTalentLMSHandlers());
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (testClient) {
      await testClient.close();
      testClient = undefined;
    }
    // Clean up temp files
    try {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function writeBridgeState(port: number, token: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talentlms-bridge-'));
    const bridgeStatePath = path.join(tmpDir, 'bridge-state.json');
    fs.writeFileSync(bridgeStatePath, JSON.stringify({ port, token }));
    return bridgeStatePath;
  }

  it('configure tool uses bridge when MCP_HOST_BRIDGE_STATE is set — success path', async () => {
    const bridgePath = writeBridgeState(19876, 'test-bridge-token');

    // Set up bridge handler for success
    const bridgeHandlers = createBridgeHandlers(19876);
    mswServer.use(...bridgeHandlers);

    testClient = await createTestClient({
      env: {
        TALENTLMS_API_KEY: '',
        TALENTLMS_DOMAIN: '',
        MCP_HOST_BRIDGE_STATE: bridgePath,
      },
    });

    const result = await testClient.callTool('configure_talentlms', {
      api_key: MOCK_API_KEY,
      domain: MOCK_DOMAIN,
    });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.message).toContain('configured successfully');
  });

  it('configure tool returns isError when bridge returns 401', async () => {
    const bridgePath = writeBridgeState(19877, 'wrong-token');

    // Set up a custom bridge handler that always returns 401
    mswServer.use(
      http.post('http://127.0.0.1:19877/*', () => {
        return HttpResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }),
    );

    testClient = await createTestClient({
      env: {
        TALENTLMS_API_KEY: '',
        TALENTLMS_DOMAIN: '',
        MCP_HOST_BRIDGE_STATE: bridgePath,
      },
    });

    const result = await testClient.callTool('configure_talentlms', {
      api_key: MOCK_API_KEY,
      domain: MOCK_DOMAIN,
    });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('configure tool returns isError when bridge returns failure', async () => {
    const bridgePath = writeBridgeState(19878, 'test-bridge-token');

    // Custom bridge handler that returns success: false
    mswServer.use(
      http.post('http://127.0.0.1:19878/*', () => {
        return HttpResponse.json({ success: false, error: 'Configuration rejected by host' });
      }),
    );

    testClient = await createTestClient({
      env: {
        TALENTLMS_API_KEY: '',
        TALENTLMS_DOMAIN: '',
        MCP_HOST_BRIDGE_STATE: bridgePath,
      },
    });

    const result = await testClient.callTool('configure_talentlms', {
      api_key: MOCK_API_KEY,
      domain: MOCK_DOMAIN,
    });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(false);
    expect(result.isError).toBe(true);
    // Should NOT have fallen through to success
    expect(data.error).toContain('rejected');
  });
});
