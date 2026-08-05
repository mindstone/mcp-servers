import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createServiceNowHandlers } from './helpers/servicenow-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const BASE_ENV = {
  SERVICENOW_INSTANCE: '',
  SERVICENOW_USERNAME: '',
  SERVICENOW_PASSWORD: '',
  MCP_HOST_BRIDGE_STATE: '',
};

const CONFIGURE_ARGS = {
  instance: 'test-instance',
  username: 'user',
  password: 'pass',
};

/**
 * Writes a bridge state file under a fresh tmp dir and returns its path.
 * `contents` is written verbatim so malformed JSON can be exercised.
 */
function writeBridgeState(contents: string): { dir: string; statePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servicenow-bridge-adv-'));
  const statePath = path.join(dir, 'bridge.json');
  fs.writeFileSync(statePath, contents);
  return { dir, statePath };
}

describe('Bridge state hardening', () => {
  let testClient: McpTestClient;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  async function configureWithState(statePath: string) {
    testClient = await createTestClient({
      env: { ...BASE_ENV, MINDSTONE_REBEL_BRIDGE_STATE: statePath },
    });
    return testClient.callTool('configure_servicenow', CONFIGURE_ARGS);
  }

  it('a non-numeric port cannot re-interpret the URL authority (no token leaves the connector)', async () => {
    // A string port like "80@evil.example" would otherwise turn the request
    // URL into http://127.0.0.1:80@evil.example/... and exfiltrate the token.
    const { dir, statePath } = writeBridgeState(
      JSON.stringify({ port: '8' + '0@evil.example', token: 'bridge-' + 'token' }),
    );
    tmpDirs.push(dir);

    let requestMade = false;
    mswServer.use(
      http.all('*', () => {
        requestMade = true;
        return HttpResponse.json({ success: true });
      }),
      ...createServiceNowHandlers('user', 'pass'),
    );

    const result = await configureWithState(statePath);
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('BRIDGE_ERROR');
    // The state was rejected before any outbound request was attempted.
    expect(requestMade).toBe(false);
  });

  it('an out-of-range port is rejected with zero network calls', async () => {
    const { dir, statePath } = writeBridgeState(JSON.stringify({ port: 70000, token: 't' }));
    tmpDirs.push(dir);

    let requestMade = false;
    mswServer.use(
      http.all('*', () => {
        requestMade = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const result = await configureWithState(statePath);
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });

  it('malformed JSON state is rejected observably (stderr) with zero network calls', async () => {
    const { dir, statePath } = writeBridgeState('{ not json');
    tmpDirs.push(dir);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let requestMade = false;
    mswServer.use(
      http.all('*', () => {
        requestMade = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const result = await configureWithState(statePath);
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
    // Fail-open must be observable: the rejection is logged, not swallowed.
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[servicenow] bridge state rejected:'),
    );
  });

  it('a symlinked state file is refused (O_NOFOLLOW)', async () => {
    const { dir, statePath } = writeBridgeState(JSON.stringify({ port: 9999, token: 't' }));
    tmpDirs.push(dir);
    const linkPath = path.join(dir, 'bridge-link.json');
    fs.symlinkSync(statePath, linkPath);

    let requestMade = false;
    mswServer.use(
      http.all('*', () => {
        requestMade = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const result = await configureWithState(linkPath);
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });

  it('a directory at the state path is refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servicenow-bridge-dir-'));
    tmpDirs.push(dir);

    let requestMade = false;
    mswServer.use(
      http.all('*', () => {
        requestMade = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const result = await configureWithState(dir);
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });

  it('an oversized state file is refused', async () => {
    const oversized = `{"port":9999,"token":"${'x'.repeat(128 * 1024)}"}`;
    const { dir, statePath } = writeBridgeState(oversized);
    tmpDirs.push(dir);

    let requestMade = false;
    mswServer.use(
      http.all('*', () => {
        requestMade = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const result = await configureWithState(statePath);
    expect(result.isError).toBe(true);
    expect(requestMade).toBe(false);
  });

  it('a bridge response with an unexpected shape surfaces a safe error', async () => {
    const { dir, statePath } = writeBridgeState(JSON.stringify({ port: 9999, token: 't' }));
    tmpDirs.push(dir);

    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/servicenow/configure', () =>
        // Not the { success, warning?, error? } contract.
        HttpResponse.json({ ok: true }),
      ),
    );

    const result = await configureWithState(statePath);
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(json.error).toContain('unexpected response shape');
  });

  it('a non-JSON bridge response surfaces a safe error', async () => {
    const { dir, statePath } = writeBridgeState(JSON.stringify({ port: 9999, token: 't' }));
    tmpDirs.push(dir);

    mswServer.use(
      http.post(
        'http://127.0.0.1:9999/bundled/servicenow/configure',
        () => new HttpResponse('<html>oops</html>', { status: 200 }),
      ),
    );

    const result = await configureWithState(statePath);
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(json.error).toContain('non-JSON');
  });
});
