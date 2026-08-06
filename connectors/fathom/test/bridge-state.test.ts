import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mswServer } from './helpers/setup.js';
import { createFathomHandlers } from './helpers/fathom-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const API_KEY = 'test-fathom-key';

/**
 * The bridge state file is host-injected configuration, but its content is
 * still validated before use: a non-integer `port` would otherwise be
 * interpolated into the loopback URL and could redirect the request (carrying
 * the bridge token and the user's API key) off-host, and a symlinked state
 * file must be refused rather than followed.
 */
describe('Bridge state file validation', () => {
  let testClient: McpTestClient;
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeBridgeState(contents: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fathom-bridge-state-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, contents);
    return bridgePath;
  }

  async function clientWithBridgeState(bridgePath: string): Promise<McpTestClient> {
    return createTestClient({
      env: {
        FATHOM_API_KEY: '',
        MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
  }

  async function expectBridgeUnavailable() {
    const result = await testClient.callTool('configure_fathom_api_key', { api_key: API_KEY });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; code: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Bridge not available');
    expect(json.code).toBe('BRIDGE_ERROR');
  }

  it('rejects a non-numeric port and sends no request off-host', async () => {
    // WHATWG URL parsing would treat `127.0.0.1:1` as userinfo and
    // `evil.example` as the host if this string reached the fetch URL.
    let evilRequests = 0;
    mswServer.use(
      http.post('http://evil.example/bundled/fathom/configure', () => {
        evilRequests++;
        return HttpResponse.json({ success: true });
      }),
      ...createFathomHandlers(API_KEY),
    );

    const bridgePath = writeBridgeState(JSON.stringify({ port: '1@evil.example', token: 'test-token' }));
    testClient = await clientWithBridgeState(bridgePath);

    await expectBridgeUnavailable();
    expect(evilRequests).toBe(0);
  });

  it('rejects an out-of-range port', async () => {
    const bridgePath = writeBridgeState(JSON.stringify({ port: 70000, token: 'test-token' }));
    testClient = await clientWithBridgeState(bridgePath);

    await expectBridgeUnavailable();
  });

  it('rejects a state file with a missing token', async () => {
    const bridgePath = writeBridgeState(JSON.stringify({ port: 9999 }));
    testClient = await clientWithBridgeState(bridgePath);

    await expectBridgeUnavailable();
  });

  it('rejects a symlinked state file', async () => {
    const realPath = writeBridgeState(JSON.stringify({ port: 9999, token: 'test-token' }));
    const linkPath = path.join(tmpDir as string, 'bridge-link.json');
    fs.symlinkSync(realPath, linkPath);
    testClient = await clientWithBridgeState(linkPath);

    await expectBridgeUnavailable();
  });

  it('accepts a valid state file', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/fathom/configure', () =>
        HttpResponse.json({ success: true }),
      ),
      ...createFathomHandlers(API_KEY),
    );

    const bridgePath = writeBridgeState(JSON.stringify({ port: 9999, token: 'test-token' }));
    testClient = await clientWithBridgeState(bridgePath);

    const result = await testClient.callTool('configure_fathom_api_key', { api_key: API_KEY });
    const json = result.json as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toContain('configured successfully');
  });
});
