import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createTempConfig } from '@mindstone/mcp-test-harness';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { TOKEN_URL, createTokenResponse } from './fixtures/quickbooks-data.js';

const BRIDGE_PORT = 19878;
const BRIDGE_TOKEN = 'test-bridge-token';
const ENVELOPE_OPEN = '<untrusted-content source=';

const configureArgs = {
  clientId: 'new-id',
  clientSecret: 'new-secret',
  refreshToken: 'new-token',
  realmId: 'new-realm',
};

function bridgeEnv(statePath: string) {
  return {
    QUICKBOOKS_CLIENT_ID: '',
    QUICKBOOKS_CLIENT_SECRET: '',
    QUICKBOOKS_REFRESH_TOKEN: '',
    QUICKBOOKS_REALM_ID: '',
    MCP_HOST_BRIDGE_STATE: statePath,
  };
}

describe('Bridge reader adoption', () => {
  let testClient: McpTestClient | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    testClient = undefined;
    if (cleanup) await cleanup();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  it.skipIf(process.platform === 'win32')('refuses a bridge state file that is a symlink', async () => {
    const tempConfig = createTempConfig({ prefix: 'quickbooks-bridge-symlink-' });
    cleanup = tempConfig.cleanup;
    const realPath = path.join(tempConfig.configPath, 'real-state.json');
    const linkPath = path.join(tempConfig.configPath, 'linked-state.json');
    fs.writeFileSync(realPath, JSON.stringify({ port: BRIDGE_PORT, token: BRIDGE_TOKEN }));
    fs.symlinkSync(realPath, linkPath);

    let bridgeHits = 0;
    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`http://127.0.0.1:${BRIDGE_PORT}/bundled/quickbooks/configure`, () => {
        bridgeHits += 1;
        return HttpResponse.json({ success: true });
      }),
    );

    testClient = await createTestClient({ env: bridgeEnv(linkPath) });
    const result = await testClient.callTool('configure_quickbooks', configureArgs);
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('Bridge not available');
    expect(bridgeHits).toBe(0);
  });

  it('envelopes a bridge error exactly once', async () => {
    const tempConfig = createTempConfig({ prefix: 'quickbooks-bridge-envelope-' });
    cleanup = tempConfig.cleanup;
    const statePath = path.join(tempConfig.configPath, 'bridge-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ port: BRIDGE_PORT, token: BRIDGE_TOKEN }));

    mswServer.use(
      http.post(TOKEN_URL, () => HttpResponse.json(createTokenResponse())),
      http.post(`http://127.0.0.1:${BRIDGE_PORT}/bundled/quickbooks/configure`, () =>
        HttpResponse.json({ success: false, error: 'x' }),
      ),
    );

    testClient = await createTestClient({ env: bridgeEnv(statePath) });
    const result = await testClient.callTool('configure_quickbooks', configureArgs);
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    const error = String(json.error);
    expect(error.split(ENVELOPE_OPEN).length - 1).toBe(1);
    expect(error).toContain('>x</untrusted-content>');
  });
});
