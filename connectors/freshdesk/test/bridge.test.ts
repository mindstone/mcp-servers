import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig } from '@mindstone/mcp-test-harness';
import { readFileSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * The bridge state file is read only through the vendored hardened reader
 * (src/bridge-reader.ts). With a bridge path configured, configure_freshdesk
 * fails closed: any refusal or bad reply is BRIDGE_ERROR, and the API key is
 * never written to the local accounts.json instead.
 */

const BRIDGE_PORT = 19878;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}/bundled/freshdesk/configure`;
const isWindows = process.platform === 'win32';

describe('Freshdesk bridge reader', () => {
  let testClient: McpTestClient | undefined;
  let cleanupConfig: (() => void) | undefined;
  let bridgeRequests = 0;
  const countBridge = ({ request }: { request: Request }) => {
    if (new URL(request.url).hostname === '127.0.0.1') bridgeRequests += 1;
  };

  afterEach(async () => {
    mswServer.events.removeListener('request:start', countBridge);
    if (testClient) await testClient.close();
    testClient = undefined;
    if (cleanupConfig) cleanupConfig();
    cleanupConfig = undefined;
    vi.unstubAllEnvs();
  });

  /** A temp config with one stored account, and a bridge that would accept. */
  function prepare() {
    const tc = createTempConfig({
      accounts: [{ domain: 'testacme', apiKey: 'mock-test-key' }],
      defaultAccount: 'testacme',
      defaultAccountKey: 'defaultDomain',
    });
    cleanupConfig = tc.cleanup;
    bridgeRequests = 0;
    mswServer.events.on('request:start', countBridge);
    mswServer.use(http.post(BRIDGE_URL, () => HttpResponse.json({ success: true })));
    const accountsPath = join(tc.configPath, 'accounts.json');
    return { configPath: tc.configPath, accountsPath, before: readFileSync(accountsPath) };
  }

  async function configure(env: Record<string, string>) {
    testClient = await createTestClient({ env });
    const result = await testClient.client.callTool({
      name: 'configure_freshdesk',
      arguments: { domain: 'bridgetest', api_key: 'bridge-key' },
    });
    return JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
  }

  function writeState(dir: string, name = 'bridge-state.json'): string {
    const statePath = join(dir, name);
    writeFileSync(statePath, JSON.stringify({ port: BRIDGE_PORT, token: 'tok' }));
    return statePath;
  }

  it('reaches the bridge through a regular state file (control)', async () => {
    const { configPath, accountsPath, before } = prepare();
    const parsed = await configure({
      FRESHDESK_CONFIG_PATH: configPath,
      MCP_HOST_BRIDGE_STATE: writeState(configPath),
    });
    expect(parsed.ok).toBe(true);
    expect(bridgeRequests).toBe(1);
    expect(readFileSync(accountsPath).equals(before)).toBe(true);
  });

  for (const envVar of ['MCP_HOST_BRIDGE_STATE', 'MINDSTONE_REBEL_BRIDGE_STATE'] as const) {
    it.skipIf(isWindows)(
      `refuses a symlinked state file via ${envVar}: BRIDGE_ERROR, no request, no local write`,
      async () => {
        const { configPath, accountsPath, before } = prepare();
        const target = writeState(configPath, 'real-state.json');
        const link = join(configPath, 'linked-state.json');
        symlinkSync(target, link);

        const parsed = await configure({
          FRESHDESK_CONFIG_PATH: configPath,
          MCP_HOST_BRIDGE_STATE: '',
          [envVar]: link,
        });
        expect(parsed.ok).toBe(false);
        expect(parsed.code).toBe('BRIDGE_ERROR');
        expect(parsed.error).toContain('Bridge not available');
        expect(bridgeRequests).toBe(0);
        expect(readFileSync(accountsPath).equals(before)).toBe(true);
      },
    );
  }

  it('fails closed when the configured state file does not exist', async () => {
    const { configPath, accountsPath, before } = prepare();
    const parsed = await configure({
      FRESHDESK_CONFIG_PATH: configPath,
      MCP_HOST_BRIDGE_STATE: join(configPath, 'missing-state.json'),
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('BRIDGE_ERROR');
    expect(bridgeRequests).toBe(0);
    expect(readFileSync(accountsPath).equals(before)).toBe(true);
  });

  it('reports a wrongly typed success field as a failure, not success', async () => {
    const { configPath, accountsPath, before } = prepare();
    mswServer.use(http.post(BRIDGE_URL, () => HttpResponse.json({ success: 'false' })));
    const parsed = await configure({
      FRESHDESK_CONFIG_PATH: configPath,
      MCP_HOST_BRIDGE_STATE: writeState(configPath),
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('BRIDGE_ERROR');
    expect(parsed.error).toContain('unexpected response shape');
    expect(readFileSync(accountsPath).equals(before)).toBe(true);
  });

  it('reports a non-JSON reply as a failure', async () => {
    const { configPath, accountsPath, before } = prepare();
    mswServer.use(
      http.post(BRIDGE_URL, () =>
        new HttpResponse('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      ),
    );
    const parsed = await configure({
      FRESHDESK_CONFIG_PATH: configPath,
      MCP_HOST_BRIDGE_STATE: writeState(configPath),
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('BRIDGE_ERROR');
    expect(parsed.error).toContain('malformed response');
    expect(readFileSync(accountsPath).equals(before)).toBe(true);
  });
});
