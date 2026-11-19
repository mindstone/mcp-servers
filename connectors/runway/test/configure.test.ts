import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createRunwayHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const SESSION_ONLY_MESSAGE =
  "Your Runway API key is available while this connector is running. It has not been saved, so you may need to configure it again after the connector restarts. To keep it, save it in your app's connector settings; do not send it in chat.";
const UNREACHABLE_MESSAGE =
  'Could not confirm that your API key was saved. Reopen the app and try setup again in connector settings.';
const PORT = 19995;
const BRIDGE_URL = `http://127.0.0.1:${PORT}/bundled/runway/configure`;
const KEY = 'key_fictional-runway-key-0001';

interface ConfigureJson {
  ok: boolean;
  message?: string;
  error?: string;
  code?: string;
}

describe('configure_runway_api_key through the shared bridge reader', () => {
  let testClient: McpTestClient | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    testClient = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function stateDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-bridge-'));
    return tmpDir;
  }

  function writeState(content: string): string {
    const file = path.join(stateDir(), 'bridge.json');
    fs.writeFileSync(file, content, { mode: 0o600 });
    return file;
  }

  async function configure(statePath: string, apiKey = KEY): Promise<{ json: ConfigureJson; isError: boolean; text: string }> {
    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: '', MCP_HOST_BRIDGE_STATE: statePath, MINDSTONE_REBEL_BRIDGE_STATE: '' },
    });
    const result = await testClient.callTool('configure_runway_api_key', { api_key: apiKey });
    return { json: result.json as ConfigureJson, isError: Boolean(result.isError), text: result.text };
  }

  async function balanceWorks(): Promise<boolean> {
    const result = await testClient!.callTool('get_runway_balance', {});
    return !result.isError;
  }

  it('success keeps the key and shows the enveloped warning', async () => {
    const statePath = writeState(JSON.stringify({ port: PORT, token: 'fictional-token' }));
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: true, warning: 'Saved, but sync is off.' })),
      ...createRunwayHandlers(KEY),
    );

    const { json, isError } = await configure(statePath);

    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.message).toContain('Runway API key configured.');
    expect(json.message).not.toMatch(/verified|connected/i);
    expect(json.message).toContain('<untrusted-content source="runway:bridge.warning">Saved, but sync is off.</untrusted-content>');
    expect(await balanceWorks()).toBe(true);
  });

  it('no bridge configured keeps the key for this session and says it was not saved', async () => {
    mswServer.use(...createRunwayHandlers(KEY));
    const { json, isError } = await configure('');

    expect(isError).toBe(false);
    expect(json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(await balanceWorks()).toBe(true);
  });

  it.each([
    ['a symbolic link', () => {
      const dir = stateDir();
      const real = path.join(dir, 'real.json');
      fs.writeFileSync(real, JSON.stringify({ port: PORT, token: 'fictional-token' }));
      const link = path.join(dir, 'link.json');
      fs.symlinkSync(real, link);
      return link;
    }],
    ['bad JSON', () => writeState('{not json')],
    ['a bad port', () => writeState(JSON.stringify({ port: 70000, token: 'fictional-token' }))],
  ])('a rejected state file (%s) takes the session-only path without calling the bridge', async (_label, makeState) => {
    let bridgeCalls = 0;
    mswServer.use(
      http.post(BRIDGE_URL, () => {
        bridgeCalls++;
        return HttpResponse.json({ success: true });
      }),
      ...createRunwayHandlers(KEY),
    );
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { json, isError } = await configure(makeState());

    expect(isError).toBe(false);
    expect(json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(bridgeCalls).toBe(0);
    expect(stderr.mock.calls.some((c) => String(c[0]).includes('[runway] bridge state rejected'))).toBe(true);
  });

  it('an unauthorized bridge reply is a BRIDGE_ERROR and the key is not kept', async () => {
    const statePath = writeState(JSON.stringify({ port: PORT, token: 'fictional-token' }));
    mswServer.use(http.post(BRIDGE_URL, () => new HttpResponse(null, { status: 401 })), ...createRunwayHandlers(KEY));

    const { json, isError } = await configure(statePath);

    expect(isError).toBe(true);
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(json.error).toContain('401');
    expect(await balanceWorks()).toBe(false);
  });

  it('any other bridge failure is a BRIDGE_ERROR carrying the enveloped bridge error', async () => {
    const statePath = writeState(JSON.stringify({ port: PORT, token: 'fictional-token' }));
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: false, error: 'Account validation failed' })),
      ...createRunwayHandlers(KEY),
    );

    const { json, isError } = await configure(statePath);

    expect(isError).toBe(true);
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(json.error).toBe('<untrusted-content source="runway:bridge.error">Account validation failed</untrusted-content>');
    expect(await balanceWorks()).toBe(false);
  });

  it('a thrown bridge request gives fixed text, never the error message', async () => {
    const statePath = writeState(JSON.stringify({ port: PORT, token: 'fictional-token' }));
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).startsWith(`http://127.0.0.1:${PORT}`)) {
        throw new TypeError(`fetch failed: SENTINEL-bridge-detail ${KEY}`);
      }
      return realFetch(input, init);
    });

    const { json, isError, text } = await configure(statePath);

    expect(isError).toBe(true);
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(json.error).toBe(UNREACHABLE_MESSAGE);
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain(KEY);
  });

  it('redacts an echoed key in the bridge warning', async () => {
    const statePath = writeState(JSON.stringify({ port: PORT, token: 'fictional-token' }));
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: true, warning: `Stored ${KEY} (again: ${KEY})` })),
      ...createRunwayHandlers(KEY),
    );

    const { json, text } = await configure(statePath);

    expect(json.ok).toBe(true);
    expect(text).not.toContain(KEY);
    expect(json.message).toContain(
      '<untrusted-content source="runway:bridge.warning">Stored [REDACTED] (again: [REDACTED])</untrusted-content>',
    );
  });

  it('redacts an echoed key in the bridge error', async () => {
    const statePath = writeState(JSON.stringify({ port: PORT, token: 'fictional-token' }));
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: false, error: `Key ${KEY} was refused` })),
    );

    const { json, text } = await configure(statePath);

    expect(json.code).toBe('BRIDGE_ERROR');
    expect(text).not.toContain(KEY);
    expect(json.error).toBe('<untrusted-content source="runway:bridge.error">Key [REDACTED] was refused</untrusted-content>');
  });

  it('refuses a key the filter could not find in every echo, before any bridge request', async () => {
    let bridgeCalls = 0;
    const statePath = writeState(JSON.stringify({ port: PORT, token: 'fictional-token' }));
    mswServer.use(
      http.post(BRIDGE_URL, () => {
        bridgeCalls++;
        return HttpResponse.json({ success: true });
      }),
    );
    for (const risky of ['risky"canary\\\\key', 'canary<key>&1', 'short1', 'canary key 01']) {
      const { isError, text } = await configure(statePath, risky);
      expect(isError).toBe(true);
      expect(text).not.toContain('canary');
      expect(text).toContain('does not look like an API key');
      await testClient!.close();
      testClient = undefined;
    }
    expect(bridgeCalls).toBe(0);
  });

  it('filters a key the bridge rejects, though it is never stored', async () => {
    const rejected = 'key_fictional-rejected-canary-0009';
    const statePath = writeState(JSON.stringify({ port: PORT, token: 'fictional-token' }));
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: false, error: `Invalid key ${rejected}` })),
      ...createRunwayHandlers(KEY),
    );

    const { json, text } = await configure(statePath, rejected);

    expect(json.code).toBe('BRIDGE_ERROR');
    expect(text).not.toContain(rejected);
    expect(json.error).toBe('<untrusted-content source="runway:bridge.error">Invalid key [REDACTED]</untrusted-content>');
    expect(await balanceWorks()).toBe(false);
  });
});
