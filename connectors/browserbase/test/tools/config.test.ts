import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createBridgeHandlers } from '@mindstone/mcp-test-harness';
import { mswServer } from '../helpers/setup.js';
import { createBrowserbaseHandlers, MOCK_API_KEY } from '../helpers/browserbase-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

const BRIDGE_PORT = 19891;
const BRIDGE_TOKEN = 'test-bridge-token';
const CONFIGURE_ENDPOINT = '/configure/browserbase';

describe('configure_browserbase_api_key — host bridge', () => {
  let testClient: McpTestClient | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    mswServer.events.removeAllListeners();
    if (testClient) {
      await testClient.close();
      testClient = undefined;
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeBridgeState(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbase-bridge-'));
    const statePath = path.join(tmpDir, 'bridge-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ port: BRIDGE_PORT, token: BRIDGE_TOKEN }));
    return statePath;
  }

  /** Record every request to the bridge port: URL, Authorization and JSON body. */
  function captureBridgeRequests() {
    type Seen = { url: string; authorization: string | null; body: unknown };
    const pending: Array<Promise<Seen>> = [];
    mswServer.events.on('request:start', ({ request }: { request: Request }) => {
      if (!request.url.startsWith(`http://127.0.0.1:${BRIDGE_PORT}/`)) return;
      const url = request.url;
      const authorization = request.headers.get('authorization');
      pending.push(request.clone().json().then((body: unknown) => ({ url, authorization, body })));
    });
    // Await every capture so assertions never race the body read.
    return () => Promise.all(pending);
  }

  async function configureAndListProjects(env: Record<string, string>) {
    mswServer.use(...createBrowserbaseHandlers());
    testClient = await createTestClient({ env: { BROWSERBASE_API_KEY: '', ...env } });
    const configured = await testClient.callTool('configure_browserbase_api_key', { api_key: MOCK_API_KEY });
    // The key is live for this server either way.
    const projects = await testClient.callTool('list_projects', {});
    return { configured, projects };
  }

  it('saves the key through the bridge when the bridge accepts it', async () => {
    mswServer.use(...createBridgeHandlers(BRIDGE_PORT));
    const seen = captureBridgeRequests();
    const { configured, projects } = await configureAndListProjects({
      MCP_HOST_BRIDGE_STATE: writeBridgeState(),
      MCP_BRIDGE_CONFIGURE_ENDPOINT: CONFIGURE_ENDPOINT,
    });

    expect(configured.isError).toBeFalsy();
    const json = configured.json as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toContain('Browserbase API key configured!');
    expect(json.message).not.toContain(MOCK_API_KEY);
    expect(await seen()).toEqual([
      {
        url: `http://127.0.0.1:${BRIDGE_PORT}${CONFIGURE_ENDPOINT}`,
        authorization: `Bearer ${BRIDGE_TOKEN}`,
        body: { apiKey: MOCK_API_KEY },
      },
    ]);
    expect(projects.isError).toBeFalsy();
  });

  it('passes the bridge warning through, enveloped', async () => {
    mswServer.use(...createBridgeHandlers(BRIDGE_PORT, { successData: { warning: 'Saved for this device only' } }));
    const { configured } = await configureAndListProjects({
      MCP_HOST_BRIDGE_STATE: writeBridgeState(),
      MCP_BRIDGE_CONFIGURE_ENDPOINT: CONFIGURE_ENDPOINT,
    });
    const json = configured.json as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toBe(
      'Browserbase API key configured. Note: <untrusted-content source="browserbase:bridge.warning">Saved for this device only</untrusted-content>',
    );
  });

  it('falls back to session-only when no bridge state is set', async () => {
    const seen = captureBridgeRequests();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { configured, projects } = await configureAndListProjects({
      MCP_HOST_BRIDGE_STATE: '',
      MINDSTONE_REBEL_BRIDGE_STATE: '',
      MCP_BRIDGE_CONFIGURE_ENDPOINT: CONFIGURE_ENDPOINT,
    });
    const json = configured.json as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Browserbase API key configured for this session.');
    expect(await seen()).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
    expect(projects.isError).toBeFalsy();
  });

  it('falls back to session-only when the host sets no configure endpoint', async () => {
    const seen = captureBridgeRequests();
    const { configured } = await configureAndListProjects({
      MCP_HOST_BRIDGE_STATE: writeBridgeState(),
      MCP_BRIDGE_CONFIGURE_ENDPOINT: '',
    });
    expect((configured.json as { message: string }).message).toBe('Browserbase API key configured for this session.');
    expect(await seen()).toEqual([]);
  });

  it('falls back to session-only when the bridge refuses the key', async () => {
    mswServer.use(...createBridgeHandlers(BRIDGE_PORT, { error: 'store unavailable' }));
    const { configured, projects } = await configureAndListProjects({
      MCP_HOST_BRIDGE_STATE: writeBridgeState(),
      MCP_BRIDGE_CONFIGURE_ENDPOINT: CONFIGURE_ENDPOINT,
    });
    const json = configured.json as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toBe('Browserbase API key configured for this session.');
    expect(projects.isError).toBeFalsy();
  });
});
