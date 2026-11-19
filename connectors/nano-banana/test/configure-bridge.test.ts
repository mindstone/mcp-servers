/**
 * configure_nano_banana_api_key through the vendored hardened bridge reader:
 * the four branches, hostile state files, and keys echoed back by the bridge.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createNanoBananaHandlers } from './helpers/nano-banana-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { wrapUntrusted } from '../src/untrusted-content.js';

const SESSION_ONLY_MESSAGE =
  "Your Gemini API key is available while this connector is running. It has not been saved, so you may need to configure it again after the connector restarts. To keep it, save it in your app's connector settings; do not send it in chat.";
const UNREACHABLE_MESSAGE =
  'Could not confirm that your API key was saved. Reopen the app and try setup again in connector settings.';
const CONFIGURED_MESSAGE =
  'Gemini API key configured. You can now use nano_banana_generate and nano_banana_edit to create and edit images.';
const PORT = 19995;
const BRIDGE_URL = `http://127.0.0.1:${PORT}/bundled/nanobanana/configure`;
const API_KEY = 'AIzaFakeKeyForTests-0123456789';

describe('Nano Banana configure through the hardened bridge reader', () => {
  let testClient: McpTestClient | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    testClient = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function writeState(contents: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-bridge-hardened-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, contents);
    return bridgePath;
  }

  const goodState = () => writeState(JSON.stringify({ port: PORT, token: 'test-token' }));

  async function client(bridgePath: string): Promise<McpTestClient> {
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: '', MCP_HOST_BRIDGE_STATE: bridgePath },
    });
    return testClient;
  }

  async function configure(c: McpTestClient, apiKey = API_KEY) {
    return c.callTool('configure_nano_banana_api_key', { api_key: apiKey });
  }

  /** Whether the key was kept: a generation call reaches the (mocked) Gemini API. */
  async function keyUsable(c: McpTestClient): Promise<boolean> {
    const after = await c.callTool('nano_banana_generate', { prompt: 'test' });
    return !after.isError;
  }

  it('says "configured" (not verified or connected) when the bridge saves the key', async () => {
    mswServer.use(http.post(BRIDGE_URL, () => HttpResponse.json({ success: true })), ...createNanoBananaHandlers(API_KEY));
    const c = await client(goodState());
    const result = await configure(c);
    expect(result.json).toEqual({ ok: true, message: CONFIGURED_MESSAGE });
    expect(result.text).not.toMatch(/verified|connected/i);
    expect(await keyUsable(c)).toBe(true);
  });

  it('keeps the bridge warning visible, enveloped, on success', async () => {
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: true, warning: 'Saved to the local keychain only' })),
      ...createNanoBananaHandlers(API_KEY),
    );
    const c = await client(goodState());
    const json = (await configure(c)).json as { ok: boolean; message: string };
    expect(json).toEqual({
      ok: true,
      message: `Gemini API key configured. Note: ${wrapUntrusted('Saved to the local keychain only', 'nano-banana:bridge.warning')}`,
    });
    expect(await keyUsable(c)).toBe(true);
  });

  it('with no bridge, keeps the key for this session and says it was not saved', async () => {
    mswServer.use(...createNanoBananaHandlers(API_KEY));
    const c = await client('');
    const result = await configure(c);
    expect(result.isError).toBeFalsy();
    expect(result.json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(await keyUsable(c)).toBe(true);
  });

  it('refuses a symlinked state file: no bridge request, session-only key', async () => {
    let bridgeCalls = 0;
    mswServer.use(
      http.post(BRIDGE_URL, () => {
        bridgeCalls++;
        return HttpResponse.json({ success: true });
      }),
      ...createNanoBananaHandlers(API_KEY),
    );
    const real = goodState();
    const link = path.join(tmpDir!, 'bridge-link.json');
    fs.symlinkSync(real, link);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await client(link);
    const result = await configure(c);
    expect(result.json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(bridgeCalls).toBe(0);
    expect(stderr).toHaveBeenCalledWith('[nano-banana] bridge state rejected: state path is a symbolic link');
    expect(await keyUsable(c)).toBe(true);
  });

  it('refuses a state file with bad JSON: session-only key', async () => {
    mswServer.use(...createNanoBananaHandlers(API_KEY));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await client(writeState('{ not json'));
    const result = await configure(c);
    expect(result.json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(stderr).toHaveBeenCalledWith('[nano-banana] bridge state rejected: malformed JSON');
  });

  it('refuses a state file whose port could change the request host', async () => {
    let offHost = 0;
    mswServer.use(
      http.post('http://evil.example/*', () => {
        offHost++;
        return HttpResponse.json({ success: true });
      }),
      ...createNanoBananaHandlers(API_KEY),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await client(writeState(JSON.stringify({ port: '1@evil.example', token: 'test-token' })));
    const result = await configure(c);
    expect(result.json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(offHost).toBe(0);
  });

  it('returns BRIDGE_ERROR on an unauthorized bridge reply and does not keep the key', async () => {
    mswServer.use(http.post(BRIDGE_URL, () => new HttpResponse(null, { status: 401 })), ...createNanoBananaHandlers(API_KEY));
    const c = await client(goodState());
    const result = await configure(c);
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; code: string };
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(json.error).toBe('Bridge returned 401: unauthorized. Check host app authentication.');
    expect(await keyUsable(c)).toBe(false);
  });

  it('returns BRIDGE_ERROR with the enveloped bridge text on any other failure', async () => {
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: false, error: 'Account validation failed' })),
      ...createNanoBananaHandlers(API_KEY),
    );
    const c = await client(goodState());
    const result = await configure(c);
    expect(result.isError).toBe(true);
    const json = result.json as { error: string; code: string };
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(json.error).toBe(wrapUntrusted('Account validation failed', 'nano-banana:bridge.error'));
    expect(await keyUsable(c)).toBe(false);
  });

  it('never puts the text of a thrown bridge request into the result', async () => {
    const SENTINEL = 'SENTINEL-bridge-secret-7c1d';
    mswServer.use(...createNanoBananaHandlers(API_KEY));
    const c = await client(goodState());
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(`http://127.0.0.1:${PORT}/`)) {
        return Promise.reject(new TypeError(`fetch failed: connect ECONNREFUSED ${SENTINEL} ${API_KEY}`));
      }
      return realFetch(input, init);
    });
    const result = await configure(c);
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(SENTINEL);
    expect(result.text).not.toContain(API_KEY);
    const json = result.json as { error: string; code: string };
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(json.error).toBe(UNREACHABLE_MESSAGE);
  });

  it('redacts the key echoed in a bridge warning, keeping the envelope', async () => {
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: true, warning: `Saved ${API_KEY}; again ${API_KEY}` })),
      ...createNanoBananaHandlers(API_KEY),
    );
    const c = await client(goodState());
    const result = await configure(c);
    expect(result.text).not.toContain(API_KEY);
    expect((result.json as { message: string }).message).toBe(
      `Gemini API key configured. Note: ${wrapUntrusted('Saved [REDACTED]; again [REDACTED]', 'nano-banana:bridge.warning')}`,
    );
  });

  it('redacts the key echoed in a bridge error, keeping the envelope', async () => {
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: false, error: `Rejected ${API_KEY}` })),
      ...createNanoBananaHandlers(API_KEY),
    );
    const c = await client(goodState());
    const result = await configure(c);
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(API_KEY);
    expect((result.json as { error: string }).error).toBe(
      wrapUntrusted('Rejected [REDACTED]', 'nano-banana:bridge.error'),
    );
  });

  it('refuses a key the filter could not find in every echo, before any bridge request', async () => {
    let bridgeCalls = 0;
    mswServer.use(
      http.post(BRIDGE_URL, () => {
        bridgeCalls++;
        return HttpResponse.json({ success: true });
      }),
    );
    const c = await client(goodState());
    for (const risky of ['risky"canary\\key', 'canary<key>&1', 'short1', 'canary key 01']) {
      const result = await configure(c, risky);
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain('canary');
      expect(result.text).toContain('does not look like an API key');
    }
    expect(bridgeCalls).toBe(0);
  });

  it('filters a key the bridge rejects, though it is never stored', async () => {
    const rejected = 'AIzaRejectedCanaryKey-9876543210';
    mswServer.use(
      http.post(BRIDGE_URL, async ({ request }) => {
        const { apiKey } = (await request.json()) as { apiKey: string };
        return HttpResponse.json({ success: false, error: `Invalid key ${apiKey}` });
      }),
      ...createNanoBananaHandlers(API_KEY),
    );
    const c = await client(goodState());
    const result = await configure(c, rejected);
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(rejected);
    expect((result.json as { error: string }).error).toBe(
      wrapUntrusted('Invalid key [REDACTED]', 'nano-banana:bridge.error'),
    );
    expect(await keyUsable(c)).toBe(false);
  });
});
