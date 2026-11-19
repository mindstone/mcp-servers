import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createKlingHandlers } from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { wrapUntrusted } from '../src/untrusted-content.js';

const SESSION_ONLY_MESSAGE =
  "Your Kling API keys are available while this connector is running. They have not been saved, so you may need to configure them again after the connector restarts. To keep them, save them in your app's connector settings; do not send them in chat.";
const UNREACHABLE_MESSAGE =
  'Could not confirm that your API keys were saved. Reopen the app and try setup again in connector settings.';
const BRIDGE_URL = 'http://127.0.0.1:9999/bundled/kling/configure';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-at-least-32-chars-long';

describe('Kling configure tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('configure_kling_api_keys sets keys and enables subsequent calls', async () => {
    mswServer.use(...createKlingHandlers());

    // Start without API keys
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: '', KLING_SECRET_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    // Verify calls fail without keys
    const beforeResult = await testClient.callTool('generate_kling_video', { prompt: 'test' });
    const beforeJson = beforeResult.json as { ok: boolean; error: string };
    expect(beforeJson.ok).toBe(false);
    expect(beforeJson.error).toContain('not configured');

    // Configure the keys
    const configResult = await testClient.callTool('configure_kling_api_keys', {
      access_key: ACCESS_KEY,
      secret_key: SECRET_KEY,
    });
    const configJson = configResult.json as { ok: boolean; message: string };
    expect(configJson.ok).toBe(true);
    // No bridge: the keys are kept for this session only, and the result says so.
    expect(configJson.message).toBe(SESSION_ONLY_MESSAGE);

    // Now video generation should work
    const afterResult = await testClient.callTool('generate_kling_video', { prompt: 'test' });
    const afterJson = afterResult.json as { ok: boolean; task_id: string };
    expect(afterJson.ok).toBe(true);
    expect(afterJson.task_id).toBeDefined();
  });

  it('configure_kling_api_keys rejects empty keys via Zod (requestCount=0)', async () => {
    let requestCount = 0;
    mswServer.use(
      ...createKlingHandlers(),
      http.post('http://127.0.0.1:9999/bundled/kling/configure', () => {
        requestCount++;
        return HttpResponse.json({ success: true });
      }),
    );
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: '', KLING_SECRET_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('configure_kling_api_keys', {
      access_key: '',
      secret_key: '',
    });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('configure_kling_api_keys returns isError when bridge returns 401', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/kling/configure', () => {
        return new HttpResponse(null, { status: 401 });
      }),
      ...createKlingHandlers(),
    );

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-bridge-401-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          KLING_ACCESS_KEY: '',
          KLING_SECRET_KEY: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_kling_api_keys', {
        access_key: ACCESS_KEY,
        secret_key: SECRET_KEY,
      });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; error: string; code: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('401');
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('configure_kling_api_keys returns isError when bridge returns 403', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/kling/configure', () => {
        return new HttpResponse(null, { status: 403 });
      }),
      ...createKlingHandlers(),
    );

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-bridge-403-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          KLING_ACCESS_KEY: '',
          KLING_SECRET_KEY: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_kling_api_keys', {
        access_key: ACCESS_KEY,
        secret_key: SECRET_KEY,
      });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; error: string; code: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('403');
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('configure_kling_api_keys returns isError when bridge returns success:false', async () => {
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/kling/configure', () => {
        return HttpResponse.json({ success: false, error: 'Invalid credentials' });
      }),
      ...createKlingHandlers(),
    );

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-bridge-fail-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          KLING_ACCESS_KEY: '',
          KLING_SECRET_KEY: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_kling_api_keys', {
        access_key: ACCESS_KEY,
        secret_key: SECRET_KEY,
      });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; error: string; code: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('Invalid credentials');
      expect(json.code).toBe('BRIDGE_ERROR');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('configure_kling_api_keys works with bridge available', async () => {
    // Mock bridge endpoint
    mswServer.use(
      http.post('http://127.0.0.1:9999/bundled/kling/configure', async ({ request }) => {
        const body = (await request.json()) as { accessKey: string; secretKey: string };
        if (body.accessKey && body.secretKey) {
          return HttpResponse.json({ success: true });
        }
        return HttpResponse.json({ success: false, error: 'Missing keys' });
      }),
      ...createKlingHandlers(),
    );

    // Write a temp bridge state file
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-bridge-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));

    try {
      testClient = await createTestClient({
        env: {
          KLING_ACCESS_KEY: '',
          KLING_SECRET_KEY: '',
          MINDSTONE_REBEL_BRIDGE_STATE: bridgePath,
          MCP_HOST_BRIDGE_STATE: '',
        },
      });

      const result = await testClient.callTool('configure_kling_api_keys', {
        access_key: ACCESS_KEY,
        secret_key: SECRET_KEY,
      });
      const json = result.json as { ok: boolean; message: string };
      expect(json.ok).toBe(true);
      expect(json.message).toBe(
        'Kling API keys configured. You can now use generate_kling_video to create AI videos.',
      );
      expect(json.message).not.toMatch(/verified|connected/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Kling configure through the hardened bridge reader', () => {
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

  function stateDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-bridge-hardened-'));
    return tmpDir;
  }

  function writeState(contents: string): string {
    const bridgePath = path.join(stateDir(), 'bridge.json');
    fs.writeFileSync(bridgePath, contents);
    return bridgePath;
  }

  async function client(bridgePath: string): Promise<McpTestClient> {
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: '', KLING_SECRET_KEY: '', MCP_HOST_BRIDGE_STATE: bridgePath },
    });
    return testClient;
  }

  async function configure(c: McpTestClient) {
    return c.callTool('configure_kling_api_keys', { access_key: ACCESS_KEY, secret_key: SECRET_KEY });
  }

  /** The keys work afterwards: a generation call reaches the (mocked) Kling API. */
  async function expectKeysUsable(c: McpTestClient) {
    const after = await c.callTool('generate_kling_video', { prompt: 'test' });
    expect((after.json as { ok: boolean }).ok).toBe(true);
  }

  it('keeps the bridge warning visible, enveloped, on success', async () => {
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: true, warning: 'Saved to the local keychain only' })),
      ...createKlingHandlers(),
    );
    const c = await client(writeState(JSON.stringify({ port: 9999, token: 'test-token' })));
    const json = (await configure(c)).json as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toBe(
      `Kling API keys configured. Note: ${wrapUntrusted('Saved to the local keychain only', 'kling:bridge.warning')}`,
    );
    await expectKeysUsable(c);
  });

  it('redacts both submitted keys from a bridge warning, keeping the envelope', async () => {
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: true, warning: `Saved ${ACCESS_KEY} ${SECRET_KEY}` })),
      ...createKlingHandlers(),
    );
    const c = await client(writeState(JSON.stringify({ port: 9999, token: 'test-token' })));
    const result = await configure(c);
    expect(result.text).not.toContain(ACCESS_KEY);
    expect(result.text).not.toContain(SECRET_KEY);
    const json = result.json as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toBe(
      `Kling API keys configured. Note: ${wrapUntrusted('Saved [REDACTED] [REDACTED]', 'kling:bridge.warning')}`,
    );
    await expectKeysUsable(c);
  });

  it('redacts both submitted keys from a bridge error, keeping the envelope', async () => {
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: false, error: `Rejected ${ACCESS_KEY} ${SECRET_KEY}` })),
      ...createKlingHandlers(),
    );
    const c = await client(writeState(JSON.stringify({ port: 9999, token: 'test-token' })));
    const result = await configure(c);
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(ACCESS_KEY);
    expect(result.text).not.toContain(SECRET_KEY);
    const json = result.json as { ok: boolean; error: string; code: string };
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(json.error).toBe(wrapUntrusted('Rejected [REDACTED] [REDACTED]', 'kling:bridge.error'));
  });

  it('with no bridge, keeps the keys for this session and says they were not saved', async () => {
    mswServer.use(...createKlingHandlers());
    const c = await client('');
    const result = await configure(c);
    expect(result.isError).toBeFalsy();
    expect(result.json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    await expectKeysUsable(c);
  });

  it('refuses a symlinked state file: no bridge request, session-only keys', async () => {
    let bridgeCalls = 0;
    mswServer.use(
      http.post(BRIDGE_URL, () => {
        bridgeCalls++;
        return HttpResponse.json({ success: true });
      }),
      ...createKlingHandlers(),
    );
    const real = writeState(JSON.stringify({ port: 9999, token: 'test-token' }));
    const link = path.join(tmpDir!, 'bridge-link.json');
    fs.symlinkSync(real, link);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await client(link);
    const result = await configure(c);
    expect(result.json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(bridgeCalls).toBe(0);
    expect(stderr).toHaveBeenCalledWith('[kling] bridge state rejected: state path is a symbolic link');
    await expectKeysUsable(c);
  });

  it('refuses a state file with bad JSON: session-only keys', async () => {
    mswServer.use(...createKlingHandlers());
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await client(writeState('{ not json'));
    const result = await configure(c);
    expect(result.json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(stderr).toHaveBeenCalledWith('[kling] bridge state rejected: malformed JSON');
  });

  it('refuses a state file whose port could change the request host', async () => {
    let offHost = 0;
    mswServer.use(
      http.post('http://evil.example/*', () => {
        offHost++;
        return HttpResponse.json({ success: true });
      }),
      ...createKlingHandlers(),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await client(writeState(JSON.stringify({ port: '1@evil.example', token: 'test-token' })));
    const result = await configure(c);
    expect(result.json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(offHost).toBe(0);
  });

  it('returns BRIDGE_ERROR on an unauthorized bridge reply', async () => {
    mswServer.use(http.post(BRIDGE_URL, () => new HttpResponse(null, { status: 401 })), ...createKlingHandlers());
    const c = await client(writeState(JSON.stringify({ port: 9999, token: 'test-token' })));
    const result = await configure(c);
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; code: string };
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(json.error).toBe('Bridge returned 401: unauthorized. Check host app authentication.');
    // The keys were not kept.
    const after = await c.callTool('generate_kling_video', { prompt: 'test' });
    expect((after.json as { ok: boolean }).ok).toBe(false);
  });

  it('never puts the text of a network failure into the result', async () => {
    const SENTINEL = 'SENTINEL-bridge-secret-4f2a';
    mswServer.use(...createKlingHandlers());
    const c = await client(writeState(JSON.stringify({ port: 9999, token: 'test-token' })));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('http://127.0.0.1:9999/')) {
        return Promise.reject(new TypeError(`fetch failed: connect ECONNREFUSED ${SENTINEL}`));
      }
      return realFetch(input, init);
    });
    const result = await configure(c);
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(SENTINEL);
    expect(result.text).not.toContain(SECRET_KEY);
    const json = result.json as { ok: boolean; error: string; code: string };
    expect(json.code).toBe('BRIDGE_ERROR');
    expect(json.error).toBe(UNREACHABLE_MESSAGE);
  });
});

describe('Kling configure: keys echoed back by the host app', () => {
  let testClient: McpTestClient | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (testClient) await testClient.close();
    testClient = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  /** Configure through the real handler and reader, with the bridge replying `reply(keys)`. */
  async function configureWith(
    accessKey: string,
    secretKey: string,
    reply: (body: { accessKey: string; secretKey: string }) => Record<string, unknown>,
  ) {
    mswServer.use(
      http.post(BRIDGE_URL, async ({ request }) =>
        HttpResponse.json(reply((await request.json()) as { accessKey: string; secretKey: string })),
      ),
      ...createKlingHandlers(),
    );
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-bridge-echo-'));
    const bridgePath = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(bridgePath, JSON.stringify({ port: 9999, token: 'test-token' }));
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: '', KLING_SECRET_KEY: '', MCP_HOST_BRIDGE_STATE: bridgePath },
    });
    return testClient.callTool('configure_kling_api_keys', { access_key: accessKey, secret_key: secretKey });
  }

  it('refuses keys the filter could not find in every echo, before any bridge request', async () => {
    let bridgeCalls = 0;
    for (const risky of ['risky"canary\\\\key', 'canary<key>&1', 'short1', 'canary key 01']) {
      const result = await configureWith(risky, 'SKplain-canary-012', () => {
        bridgeCalls++;
        return { success: true };
      });
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain('canary');
      expect(result.text).toContain('does not look like an API key');
      await testClient!.close();
      testClient = undefined;
      fs.rmSync(tmpDir!, { recursive: true, force: true });
      tmpDir = undefined;
    }
    expect(bridgeCalls).toBe(0);
  });

  it('filters keys the bridge rejects, though they are never stored', async () => {
    const access = 'AKrejected-canary-789';
    const secret = 'SKrejected-canary-012';
    const err = await configureWith(access, secret, (b) => ({
      success: false,
      error: `Invalid key pair ${b.accessKey}:${b.secretKey}`,
    }));
    expect(err.isError).toBe(true);
    expect(err.text).not.toContain('rejected-canary');
    expect((err.json as { error: string }).error).toBe(
      wrapUntrusted('Invalid key pair [REDACTED]:[REDACTED]', 'kling:bridge.error'),
    );
    const after = await testClient!.callTool('generate_kling_video', { prompt: 'test' });
    expect(after.isError).toBe(true);
  });

  it('redacts ordinary keys echoed raw, keeping the rest of the message and the envelope', async () => {
    const access = 'AKexample123';
    const secret = 'SKexample456';
    const err = await configureWith(access, secret, (b) => ({
      success: false,
      error: `Rejected ${b.accessKey}/${b.secretKey}; again ${b.secretKey}`,
    }));
    expect(err.text).not.toContain(access);
    expect(err.text).not.toContain(secret);
    expect((err.json as { error: string }).error).toBe(
      wrapUntrusted('Rejected [REDACTED]/[REDACTED]; again [REDACTED]', 'kling:bridge.error'),
    );
    await testClient!.close();
    testClient = undefined;
    fs.rmSync(tmpDir!, { recursive: true, force: true });
    tmpDir = undefined;

    const warn = await configureWith(access, secret, (b) => ({ success: true, warning: `Saved ${b.accessKey}` }));
    expect((warn.json as { message: string }).message).toBe(
      `Kling API keys configured. Note: ${wrapUntrusted('Saved [REDACTED]', 'kling:bridge.warning')}`,
    );
  });
});
