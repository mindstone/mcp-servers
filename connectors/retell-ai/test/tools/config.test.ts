import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createBridgeHandlers } from '@mindstone/mcp-test-harness';
import { mswServer } from '../helpers/setup.js';
import { createRetellHandlers, MOCK_API_KEY } from '../helpers/retell-mock-api.js';
import { createTestClient, type McpTestClient } from '../helpers/mcp-test-client.js';

const BRIDGE_PORT = 47311;
const CONFIGURE_ENDPOINT = '/bridge/configure';

describe('configure_retell_api_key', () => {
  let testClient: McpTestClient | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    testClient = undefined;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    vi.unstubAllEnvs();
  });

  function writeBridgeState(content: string): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retell-bridge-'));
    const statePath = path.join(tempDir, 'bridge-state.json');
    fs.writeFileSync(statePath, content);
    return statePath;
  }

  async function configure(): Promise<{ isError: boolean; body: Record<string, unknown> }> {
    const result = await testClient!.client.callTool({
      name: 'configure_retell_api_key',
      arguments: { api_key: MOCK_API_KEY },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    return { isError: result.isError === true, body: JSON.parse(text) };
  }

  /** Whether the key is now in use: a Retell call that needs it succeeds. */
  async function keyIsSet(): Promise<boolean> {
    const result = await testClient!.client.callTool({ name: 'list_agents', arguments: {} });
    return result.isError !== true;
  }

  it('without a host, sets the key for this session and says it was not saved', async () => {
    mswServer.use(...createRetellHandlers());
    testClient = await createTestClient({
      env: { RETELL_API_KEY: '', MCP_HOST_BRIDGE_STATE: '', MCP_BRIDGE_CONFIGURE_ENDPOINT: '' },
    });

    const { isError, body } = await configure();

    expect(isError).toBe(false);
    expect(body.ok).toBe(true);
    expect(body.saved).toBe(false);
    expect(body.message).toContain('not saved');
    expect(await keyIsSet()).toBe(true);
  });

  it('with a host, saves the key through the bridge', async () => {
    let received: unknown;
    mswServer.use(
      ...createRetellHandlers(),
      http.post(`http://127.0.0.1:${BRIDGE_PORT}${CONFIGURE_ENDPOINT}`, async ({ request }) => {
        received = await request.json();
        expect(request.headers.get('Authorization')).toBe('Bearer bridge-token');
        return HttpResponse.json({ success: true });
      }),
    );
    const statePath = writeBridgeState(JSON.stringify({ port: BRIDGE_PORT, token: 'bridge-token' }));
    testClient = await createTestClient({
      env: {
        RETELL_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: statePath,
        MCP_BRIDGE_CONFIGURE_ENDPOINT: CONFIGURE_ENDPOINT,
      },
    });

    const { isError, body } = await configure();

    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, saved: true });
    expect(received).toEqual({ apiKey: MOCK_API_KEY });
    expect(await keyIsSet()).toBe(true);
  });

  it('reports a refused save as a failure and does not fall back to a session-only key', async () => {
    mswServer.use(
      ...createRetellHandlers(),
      ...createBridgeHandlers(BRIDGE_PORT, { error: 'disk full' }),
    );
    const statePath = writeBridgeState(JSON.stringify({ port: BRIDGE_PORT, token: 'bridge-token' }));
    testClient = await createTestClient({
      env: {
        RETELL_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: statePath,
        MCP_BRIDGE_CONFIGURE_ENDPOINT: CONFIGURE_ENDPOINT,
      },
    });

    const { isError, body } = await configure();

    expect(isError).toBe(true);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('SAVE_FAILED');
    expect(body.error).toContain('was not saved');
    // The host's reason is passed on, enveloped as outside content.
    expect(body.error).toContain('disk full');
    expect(body.error).toContain('<untrusted-content');
    expect(await keyIsSet()).toBe(false);
  });

  it('reports an unreachable app as a failure without quoting the network error', async () => {
    mswServer.use(
      ...createRetellHandlers(),
      http.post(`http://127.0.0.1:${BRIDGE_PORT}${CONFIGURE_ENDPOINT}`, () => HttpResponse.error()),
    );
    const statePath = writeBridgeState(JSON.stringify({ port: BRIDGE_PORT, token: 'bridge-token' }));
    testClient = await createTestClient({
      env: {
        RETELL_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: statePath,
        MCP_BRIDGE_CONFIGURE_ENDPOINT: CONFIGURE_ENDPOINT,
      },
    });

    const { isError, body } = await configure();

    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, code: 'SAVE_FAILED' });
    expect(body.error).toBe('Retell AI API key was not saved: the app could not be reached.');
    expect(await keyIsSet()).toBe(false);
  });

  it('refuses a malformed bridge state file through the shared reader', async () => {
    mswServer.use(...createRetellHandlers());
    const statePath = writeBridgeState(JSON.stringify({ port: 'not-a-port', token: 'bridge-token' }));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    testClient = await createTestClient({
      env: {
        RETELL_API_KEY: '',
        MCP_HOST_BRIDGE_STATE: statePath,
        MCP_BRIDGE_CONFIGURE_ENDPOINT: CONFIGURE_ENDPOINT,
      },
    });

    const { isError, body } = await configure();

    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, code: 'SAVE_FAILED' });
    expect(body.error).toContain('Bridge not available');
    expect(stderr).toHaveBeenCalledWith(
      '[retell-ai] bridge state rejected: content failed schema validation',
    );
    expect(await keyIsSet()).toBe(false);
  });
});
