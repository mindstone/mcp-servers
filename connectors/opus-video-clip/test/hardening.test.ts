import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mswServer } from './helpers/setup.js';
import { createOpusHandlers } from './helpers/opus-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, mockProjectId, mockJobId, mockCensorJobId } from './fixtures/opus-data.js';
import { wrapUntrusted } from '../src/untrusted-content.js';

const BASE = 'https://api.opus.pro';
const BRIDGE_URL = 'http://127.0.0.1:9999/bundled/opus/configure';
const KEY_FRAGMENT = 'mcp-test';

const SESSION_ONLY_MESSAGE =
  "Your OpusClip API key is available while this connector is running. It has not been saved, so you may need to configure it again after the connector restarts. To keep it, save it in your app's connector settings; do not send it in chat.";
const UNREACHABLE_MESSAGE =
  'Could not confirm that your API key was saved. Reopen the app and try setup again in connector settings.';
const NETWORK_MESSAGE = 'Could not get a complete response from OpusClip.';
const PARSE_MESSAGE = 'OpusClip returned a response this connector could not read.';

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

async function apiClient(): Promise<McpTestClient> {
  testClient = await createTestClient({ env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' } });
  return testClient;
}

/** Wrap `fetch` so every request URL is recorded; requests still go through MSW. */
function recordFetches(): string[] {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return realFetch(input, init);
  });
  return urls;
}

/** Every stderr line written during the test, joined. */
function captureStderr(): () => string {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

describe('opusFetch only calls OpusClip API paths', () => {
  it.each([
    ['absolute URL', 'https://evil.example/api/x'],
    ['protocol-relative', '//evil.example/api/x'],
    ['slash-backslash', '/\\evil.example/api/x'],
    ['backslash inside the path', '/api\\..\\x'],
    ['userinfo-looking path', '/@evil.example/api/x'],
    ['encoded slash', '/api/clip-projects/..%2F..%2Fx'],
    ['encoded backslash (upper case)', '/api/clip-projects/%5C%5Cevil.example'],
    ['no leading slash', 'api/clip-projects'],
  ])('refuses %s before any request is made', async (_label, endpoint) => {
    mswServer.use(...createOpusHandlers());
    const urls = recordFetches();
    vi.stubEnv('OPUS_API_KEY', MOCK_API_KEY);
    vi.resetModules();
    const { opusFetch } = await import('../src/client.js');
    const error = await opusFetch(endpoint).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'INVALID_ENDPOINT' });
    expect(String((error as Error).message)).not.toContain('evil');
    expect(urls).toEqual([]);
  });

  it.each([
    ['opus_get_project', { projectId: 'https://evil.example' }],
    ['opus_get_project', { projectId: '//evil.example' }],
    ['opus_get_project', { projectId: '..\\..\\evil' }],
    ['opus_get_censor_job_status', { jobId: '../../../evil' }],
    ['opus_get_social_copy_job', { jobId: '/\\evil.example' }],
  ])('%s refuses a hostile ID %j through the tool, with no request made', async (tool, args) => {
    mswServer.use(...createOpusHandlers());
    const urls = recordFetches();
    const c = await apiClient();
    const result = await c.callTool(tool, args);
    expect(result.isError).toBe(true);
    expect((result.json as { code: string }).code).toBe('INVALID_ENDPOINT');
    expect(result.text).not.toContain('evil');
    expect(urls).toEqual([]);
  });

  it('still calls an ordinary API path', async () => {
    mswServer.use(...createOpusHandlers());
    const urls = recordFetches();
    const c = await apiClient();
    const result = await c.callTool('opus_get_project', { projectId: mockProjectId });
    expect(result.isError).toBeFalsy();
    expect(urls).toEqual([`${BASE}/api/clip-projects/${mockProjectId}`]);
  });
});

describe('network failures give fixed text', () => {
  function rejectApiFetches(message: string) {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(BASE)) return Promise.reject(new TypeError(message));
      return realFetch(input, init);
    });
  }

  it('keeps a key-bearing error message out of the result and stderr (job start)', async () => {
    mswServer.use(...createOpusHandlers());
    const stderr = captureStderr();
    const c = await apiClient();
    rejectApiFetches(`fetch failed: Authorization: Bearer ${MOCK_API_KEY} SENTINEL-net-7c1d`);
    const result = await c.callTool('opus_create_censor_job', { projectId: mockProjectId, clipId: 'CU1' });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(KEY_FRAGMENT);
    expect(result.text).not.toContain('SENTINEL');
    expect(result.json).toEqual({
      ok: false,
      error: NETWORK_MESSAGE,
      code: 'NETWORK_ERROR',
      resolution:
        'Check your internet connection. If you were starting a job, check OpusClip for an existing job before submitting it again.',
    });
    expect(stderr()).not.toContain(KEY_FRAGMENT);
    expect(stderr()).toContain('[REDACTED]');
  });

  it('says to retry the status check for a status call', async () => {
    mswServer.use(...createOpusHandlers());
    captureStderr();
    const c = await apiClient();
    rejectApiFetches(`fetch failed ${MOCK_API_KEY}`);
    const result = await c.callTool('opus_get_social_copy_job', { jobId: mockJobId });
    expect(result.text).not.toContain(KEY_FRAGMENT);
    expect(result.json).toMatchObject({
      error: NETWORK_MESSAGE,
      code: 'NETWORK_ERROR',
      resolution: 'Check your internet connection, then try the status check again.',
    });
  });
});

describe('malformed status bodies give fixed parse text', () => {
  it.each([
    ['opus_get_censor_job_status', `${BASE}/api/censor-jobs/:jobId`, { jobId: mockCensorJobId }],
    ['opus_get_social_copy_job', `${BASE}/api/social-copy-jobs/:jobId`, { jobId: mockJobId }],
  ])('%s', async (tool, route, args) => {
    // A truncated body quoting the key: a JSON parser's message would quote a
    // slice of it, so neither the result nor stderr may carry the parser text.
    mswServer.use(
      http.get(route, () => new HttpResponse(`{"status": "FAILED", "error": "${MOCK_API_KEY}`, { status: 200 })),
    );
    const stderr = captureStderr();
    const c = await apiClient();
    const result = await c.callTool(tool, args);
    expect(result.isError).toBe(true);
    expect(result.json).toEqual({
      ok: false,
      error: PARSE_MESSAGE,
      code: 'PARSE_ERROR',
      resolution: 'Try the status check again.',
    });
    expect(result.text).not.toContain(KEY_FRAGMENT);
    expect(stderr()).not.toContain(KEY_FRAGMENT);
    expect(stderr()).not.toMatch(/JSON at position|Unterminated|Unexpected/);
  });
});

describe('the configured key never comes back in upstream text', () => {
  it('redacts a key echoed in a 422 body before truncating it', async () => {
    // The key straddles the 1000-character cut: truncating first would leave a fragment.
    const body = `${'x'.repeat(990)}${MOCK_API_KEY} tail`;
    mswServer.use(http.get(`${BASE}/api/clip-projects/:projectId`, () => new HttpResponse(body, { status: 422 })));
    const c = await apiClient();
    const result = await c.callTool('opus_get_project', { projectId: mockProjectId });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(KEY_FRAGMENT);
    const json = result.json as { error: string; code: string };
    expect(json.code).toBe('VALIDATION_ERROR');
    expect(json.error).toBe(
      `Validation error: ${wrapUntrusted(`${'x'.repeat(990)}[REDACTED]`, 'opus:api:validation_error_body')}`,
    );
  });

  it('redacts the key from a failed censor job reason', async () => {
    mswServer.use(
      http.get(`${BASE}/api/censor-jobs/:jobId`, () =>
        HttpResponse.json({ status: 'FAILED', error: `Bad token ${MOCK_API_KEY}` }),
      ),
    );
    const c = await apiClient();
    const result = await c.callTool('opus_get_censor_job_status', { jobId: mockCensorJobId });
    expect(result.text).not.toContain(KEY_FRAGMENT);
    const json = result.json as { error: string; category: string };
    expect(json.category).toBe('failed');
    expect(json.error).toBe(wrapUntrusted('Bad token [REDACTED]', 'opus:get_censor_job_status:error'));
  });

  it('redacts the key from social-copy text and other 2xx fields', async () => {
    mswServer.use(
      http.get(`${BASE}/api/social-copy-jobs/:jobId`, () =>
        HttpResponse.json({ data: { status: 'COMPLETED', title: `Title ${MOCK_API_KEY}`, description: 'ok' } }),
      ),
      http.get(`${BASE}/api/clip-projects/:projectId`, () =>
        HttpResponse.json({ id: mockProjectId, stage: 'COMPLETE', note: `see ${MOCK_API_KEY}` }),
      ),
    );
    const c = await apiClient();
    const copy = await c.callTool('opus_get_social_copy_job', { jobId: mockJobId });
    expect(copy.text).not.toContain(KEY_FRAGMENT);
    expect((copy.json as { title: string }).title).toBe(
      wrapUntrusted('Title [REDACTED]', 'opus:get_social_copy_job:title'),
    );
    const project = await c.callTool('opus_get_project', { projectId: mockProjectId });
    expect(project.text).not.toContain(KEY_FRAGMENT);
    expect(project.text).toContain('[REDACTED]');
  });
});

describe('configure_opus_api_key through the hardened bridge reader', () => {
  const KEY = 'opus-example-key-123';

  function writeState(contents: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-bridge-'));
    const p = path.join(tmpDir, 'bridge.json');
    fs.writeFileSync(p, contents);
    return p;
  }
  const goodState = () => writeState(JSON.stringify({ port: 9999, token: 'test-token' }));

  async function configure(bridgePath: string, key = KEY) {
    testClient = await createTestClient({ env: { OPUS_API_KEY: '', MCP_HOST_BRIDGE_STATE: bridgePath } });
    return testClient.callTool('configure_opus_api_key', { api_key: key });
  }

  /** The key works afterwards: an API call reaches the (mocked) OpusClip API. */
  async function keyUsable(): Promise<boolean> {
    const after = await testClient!.callTool('opus_get_project', { projectId: mockProjectId });
    return !after.isError;
  }

  it('saves through the bridge and keeps its warning visible, enveloped', async () => {
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: true, warning: 'Saved to the local keychain only' })),
      ...createOpusHandlers(KEY),
    );
    const result = await configure(goodState());
    expect(result.json).toEqual({
      ok: true,
      message: `OpusClip API key configured. Note: ${wrapUntrusted('Saved to the local keychain only', 'opus:bridge.warning')}`,
    });
    expect(await keyUsable()).toBe(true);
  });

  it('saves through the bridge without a warning, never claiming it was verified', async () => {
    mswServer.use(http.post(BRIDGE_URL, () => HttpResponse.json({ success: true })), ...createOpusHandlers(KEY));
    const json = (await configure(goodState())).json as { ok: boolean; message: string };
    expect(json.ok).toBe(true);
    expect(json.message).toBe(
      'OpusClip API key configured. You can now use opus_* tools to manage your video clipping projects.',
    );
    expect(json.message).not.toMatch(/verified|connected|success/i);
  });

  it('with no bridge, keeps the key for this session and says it was not saved', async () => {
    mswServer.use(...createOpusHandlers(KEY));
    const result = await configure('');
    expect(result.json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(await keyUsable()).toBe(true);
  });

  it('with a rejected state file, makes no bridge request and keeps the key for this session', async () => {
    let bridgeCalls = 0;
    mswServer.use(
      http.post(BRIDGE_URL, () => {
        bridgeCalls++;
        return HttpResponse.json({ success: true });
      }),
      ...createOpusHandlers(KEY),
    );
    const stderr = captureStderr();
    const result = await configure(writeState('{ not json'));
    expect(result.json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(bridgeCalls).toBe(0);
    expect(stderr()).toContain('[opus] bridge state rejected: malformed JSON');
    expect(await keyUsable()).toBe(true);
  });

  it('refuses a symlinked state file', async () => {
    mswServer.use(...createOpusHandlers(KEY));
    const stderr = captureStderr();
    const real = goodState();
    const link = path.join(tmpDir!, 'link.json');
    fs.symlinkSync(real, link);
    const result = await configure(link);
    expect(result.json).toEqual({ ok: true, message: SESSION_ONLY_MESSAGE });
    expect(stderr()).toContain('[opus] bridge state rejected: state path is a symbolic link');
  });

  it('returns BRIDGE_ERROR with the reader text on an unauthorized reply, and keeps no key', async () => {
    mswServer.use(http.post(BRIDGE_URL, () => new HttpResponse(null, { status: 401 })), ...createOpusHandlers(KEY));
    const result = await configure(goodState());
    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      code: 'BRIDGE_ERROR',
      error: 'Bridge returned 401: unauthorized. Check host app authentication.',
    });
    expect(await keyUsable()).toBe(false);
  });

  it('returns BRIDGE_ERROR when the bridge reports a failure', async () => {
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: false, error: 'Keychain locked' })),
      ...createOpusHandlers(KEY),
    );
    const result = await configure(goodState());
    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      code: 'BRIDGE_ERROR',
      error: wrapUntrusted('Keychain locked', 'opus:bridge.error'),
    });
    expect(await keyUsable()).toBe(false);
  });

  it('returns BRIDGE_UNREACHABLE with fixed text when the bridge request throws', async () => {
    mswServer.use(...createOpusHandlers(KEY));
    const bridgePath = goodState();
    testClient = await createTestClient({ env: { OPUS_API_KEY: '', MCP_HOST_BRIDGE_STATE: bridgePath } });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('http://127.0.0.1:9999/')) {
        return Promise.reject(new TypeError(`connect ECONNREFUSED ${KEY} SENTINEL-bridge-3b9e`));
      }
      return realFetch(input, init);
    });
    const result = await testClient.callTool('configure_opus_api_key', { api_key: KEY });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(KEY);
    expect(result.text).not.toContain('SENTINEL');
    expect(result.json).toMatchObject({ code: 'BRIDGE_UNREACHABLE', error: UNREACHABLE_MESSAGE });
  });

  it('redacts the submitted key from a bridge warning and error', async () => {
    mswServer.use(
      http.post(BRIDGE_URL, () => HttpResponse.json({ success: true, warning: `Saved ${KEY}` })),
      ...createOpusHandlers(KEY),
    );
    const warn = await configure(goodState());
    expect(warn.text).not.toContain(KEY);
    expect((warn.json as { message: string }).message).toBe(
      `OpusClip API key configured. Note: ${wrapUntrusted('Saved [REDACTED]', 'opus:bridge.warning')}`,
    );
    await testClient!.close();
    testClient = undefined;
    fs.rmSync(tmpDir!, { recursive: true, force: true });

    mswServer.use(http.post(BRIDGE_URL, () => HttpResponse.json({ success: false, error: `Rejected ${KEY}` })));
    const err = await configure(goodState());
    expect(err.text).not.toContain(KEY);
    expect(err.json).toMatchObject({
      code: 'BRIDGE_ERROR',
      error: wrapUntrusted('Rejected [REDACTED]', 'opus:bridge.error'),
    });
  });

  it('refuses a key the filter could not find in every echo, before any bridge request', async () => {
    let bridgeCalls = 0;
    mswServer.use(
      http.post(BRIDGE_URL, () => {
        bridgeCalls++;
        return HttpResponse.json({ success: true });
      }),
    );
    for (const risky of ['risky"canary\\\\key', 'canary<key>&1', 'short1', 'canary key 01']) {
      const result = await configure(goodState(), risky);
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain('canary');
      expect(result.text).toContain('does not look like an API key');
      await testClient!.close();
      testClient = undefined;
      fs.rmSync(tmpDir!, { recursive: true, force: true });
    }
    expect(bridgeCalls).toBe(0);
  });

  it('filters a key the bridge rejects, though it is never stored', async () => {
    const rejected = 'opus-rejected-canary-key-456';
    mswServer.use(
      http.post(BRIDGE_URL, async ({ request }) => {
        const { apiKey } = (await request.json()) as { apiKey: string };
        return HttpResponse.json({ success: false, error: `Invalid key ${apiKey}` });
      }),
      ...createOpusHandlers(KEY),
    );
    const err = await configure(goodState(), rejected);
    expect(err.isError).toBe(true);
    expect(err.text).not.toContain(rejected);
    expect(err.json).toMatchObject({
      code: 'BRIDGE_ERROR',
      error: wrapUntrusted('Invalid key [REDACTED]', 'opus:bridge.error'),
    });
    expect(await keyUsable()).toBe(false);
  });
});

describe('unexpected errors', () => {
  it('give fixed text; the detail reaches stderr only, without the key', async () => {
    vi.stubEnv('OPUS_API_KEY', MOCK_API_KEY);
    vi.resetModules();
    const stderr = captureStderr();
    // auth.ts registers the env key when it loads, as it does at startup.
    await import('../src/auth.js');
    const { withErrorHandling, UNEXPECTED_ERROR_MESSAGE, UNEXPECTED_ERROR_RESOLUTION } = await import(
      '../src/utils.js'
    );
    const handler = withErrorHandling(async () => {
      throw new Error(`boom ${MOCK_API_KEY} SENTINEL-unexpected-3f2a`);
    });
    const res = await handler({}, null);
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain(KEY_FRAGMENT);
    expect(text).not.toContain('SENTINEL');
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: UNEXPECTED_ERROR_MESSAGE,
      code: 'UNEXPECTED_ERROR',
      resolution: UNEXPECTED_ERROR_RESOLUTION,
    });
    expect(stderr()).toContain('SENTINEL-unexpected-3f2a');
    expect(stderr()).not.toContain(KEY_FRAGMENT);
  });
});

describe('the configured key is removed from JSON member names too', () => {
  it('opus_get_censor_job_status: names at every depth, inside arrays, in raw', async () => {
    mswServer.use(
      http.get(`${BASE}/api/censor-jobs/:jobId`, () =>
        HttpResponse.json({
          status: 'PROCESSING',
          [MOCK_API_KEY]: 'top',
          nested: { [`k-${MOCK_API_KEY}`]: { deeper: [{ [MOCK_API_KEY]: MOCK_API_KEY }] } },
        }),
      ),
    );
    const c = await apiClient();
    const result = await c.callTool('opus_get_censor_job_status', { jobId: mockCensorJobId });
    expect(result.isError).toBeFalsy();
    expect(result.text).not.toContain(KEY_FRAGMENT);
    const raw = (result.json as { raw: Record<string, unknown> }).raw;
    expect(Object.keys(raw)).toContain('[REDACTED]');
    const nested = raw.nested as Record<string, { deeper: Array<Record<string, unknown>> }>;
    expect(Object.keys(nested)).toEqual(['k-[REDACTED]']);
    expect(Object.keys(nested['k-[REDACTED]'].deeper[0])).toEqual(['[REDACTED]']);
  });

  it('opus_get_project: a key as a member name stays out of the value and the envelope source label', async () => {
    mswServer.use(
      http.get(`${BASE}/api/clip-projects/:projectId`, () =>
        HttpResponse.json({
          id: mockProjectId,
          stage: 'COMPLETE',
          [MOCK_API_KEY]: 'vendor note',
          clips: [{ [`x${MOCK_API_KEY}`]: 'clip note' }],
        }),
      ),
    );
    const c = await apiClient();
    const result = await c.callTool('opus_get_project', { projectId: mockProjectId });
    expect(result.isError).toBeFalsy();
    expect(result.text).not.toContain(KEY_FRAGMENT);
    const project = (result.json as { project: Record<string, unknown> }).project;
    expect(project['[REDACTED]']).toBe(wrapUntrusted('vendor note', 'opus:get_project:[REDACTED]'));
    expect(Object.keys((project.clips as Array<Record<string, unknown>>)[0])).toEqual(['x[REDACTED]']);
  });

  it('keeps a __proto__ member an ordinary own property', async () => {
    mswServer.use(
      http.get(`${BASE}/api/censor-jobs/:jobId`, () =>
        new HttpResponse('{"status":"PROCESSING","__proto__":{"polluted":true}}', {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const c = await apiClient();
    const result = await c.callTool('opus_get_censor_job_status', { jobId: mockCensorJobId });
    expect(result.isError).toBeFalsy();
    // Assigning `__proto__` would have replaced the prototype instead, and
    // JSON.stringify would then drop the member from the result.
    expect(result.text).toMatch(/"__proto__":\s*\{\s*"polluted":\s*true\s*\}/);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('every tool result and log line has the configured key removed', () => {
  async function clientWithEnv(env: Record<string, string>): Promise<McpTestClient> {
    testClient = await createTestClient({ env: { OPUS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '', ...env } });
    return testClient;
  }

  async function echoToolClient(apiKey: string, handler: () => Promise<string>): Promise<McpTestClient> {
    vi.stubEnv('OPUS_API_KEY', apiKey);
    vi.resetModules();
    const { withErrorHandling } = await import('../src/utils.js');
    const { withCredentialFilter } = await import('../src/server.js');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { createInMemoryTestClient } = await import('@mindstone/mcp-test-harness');
    const { z } = await import('zod');
    testClient = await createInMemoryTestClient({
      createServer: () => {
        const server = new McpServer({ name: 'echo', version: '0.0.0' });
        server.registerTool('echo', { inputSchema: z.object({}) }, withErrorHandling(handler));
        return withCredentialFilter(server);
      },
    });
    return testClient;
  }

  it('removes a key echoed as nested member names and values, inside arrays, from a registered tool result', async () => {
    const c = await echoToolClient(MOCK_API_KEY, async () =>
      JSON.stringify({
        ok: true,
        id: MOCK_API_KEY,
        nested: { [`name-${MOCK_API_KEY}`]: [{ [MOCK_API_KEY]: [MOCK_API_KEY, `x${MOCK_API_KEY}y`] }] },
      }),
    );
    const result = await c.callTool('echo', {});
    expect(result.text).not.toContain(KEY_FRAGMENT);
    expect(result.json).toEqual({
      ok: true,
      id: '[REDACTED]',
      nested: { 'name-[REDACTED]': [{ '[REDACTED]': ['[REDACTED]', 'x[REDACTED]y'] }] },
    });
  });

  it('removes the JSON-escaped form of a key that JSON escaping changes', async () => {
    const quotedKey = 'mcp-test-"quoted"\\key';
    const c = await echoToolClient(quotedKey, async () => JSON.stringify({ note: `echo ${quotedKey}` }));
    const result = await c.callTool('echo', {});
    expect(result.text).not.toContain(JSON.stringify(quotedKey).slice(1, -1));
    expect(result.text).not.toContain(KEY_FRAGMENT);
    expect(result.json).toEqual({ note: 'echo [REDACTED]' });
  });

  it('removes the key from an OpusError result', async () => {
    const c = await echoToolClient(MOCK_API_KEY, async () => {
      // Imported here so it is the same module instance the wrapper loaded.
      const { OpusError } = await import('../src/types.js');
      throw new OpusError(`bad ${MOCK_API_KEY}`, 'X', `fix ${MOCK_API_KEY}`);
    });
    const result = await c.callTool('echo', {});
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(KEY_FRAGMENT);
    expect(result.json).toEqual({ ok: false, error: 'bad [REDACTED]', code: 'X', resolution: 'fix [REDACTED]' });
  });

  it('opus_get_project: a key echoed as values inside arrays is removed', async () => {
    mswServer.use(
      http.get(`${BASE}/api/clip-projects/:projectId`, () =>
        HttpResponse.json({
          id: mockProjectId,
          stage: 'COMPLETE',
          tags: [MOCK_API_KEY, { [MOCK_API_KEY]: [MOCK_API_KEY] }],
        }),
      ),
    );
    const c = await clientWithEnv({});
    const result = await c.callTool('opus_get_project', { projectId: mockProjectId });
    expect(result.isError).toBeFalsy();
    expect(result.text).not.toContain(KEY_FRAGMENT);
    expect(result.text).toContain('[REDACTED]');
  });

  it('opus_upload_video: a key in the GCS PUT error body is removed before truncation', async () => {
    mswServer.use(...createOpusHandlers());
    mswServer.use(
      http.put('https://storage.googleapis.com/ext.gcs.opus.pro/*', ({ request }) => {
        if (request.headers.get('content-range')?.startsWith('bytes */')) {
          // Committed-offset query: report 1 byte so the resume PUT gets the error body.
          return new HttpResponse('', { status: 308, headers: { Range: 'bytes=0-0' } });
        }
        // The key straddles the 200-character cut.
        return new HttpResponse(`${'x'.repeat(190)}${MOCK_API_KEY}`, { status: 400 });
      }),
    );
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-key-ws-'));
    const videoFile = path.join(tmpDir, 'demo.mp4');
    fs.writeFileSync(videoFile, Buffer.alloc(1024, 7));
    const c = await clientWithEnv({ MCP_WORKSPACE_PATH: tmpDir });
    const result = await c.callTool('opus_upload_video', { file_path: videoFile });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(KEY_FRAGMENT);
    const data = result.json as { error: string; code: string };
    expect(data.code).toBe('UPLOAD_FAILED');
    expect(data.error).toBe(
      `GCS upload PUT returned HTTP 400: ${wrapUntrusted(`${'x'.repeat(190)}[REDACTED]`, 'opus:upload_video:gcs_error_body')}`,
    );
  });

  it('opus_upload_video: a key in the GCS session URL path is removed from the request log', async () => {
    mswServer.use(...createOpusHandlers());
    mswServer.use(
      http.post('https://storage.googleapis.com/ext.gcs.opus.pro/*', () =>
        new HttpResponse('', {
          status: 201,
          headers: {
            location: `https://storage.googleapis.com/ext.gcs.opus.pro/session/${MOCK_API_KEY}/obj?upload_id=abc`,
          },
        }),
      ),
    );
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-key-ws-'));
    const videoFile = path.join(tmpDir, 'demo.mp4');
    fs.writeFileSync(videoFile, Buffer.alloc(1024, 7));
    const stderr = captureStderr();
    const c = await clientWithEnv({ MCP_WORKSPACE_PATH: tmpDir });
    const result = await c.callTool('opus_upload_video', { file_path: videoFile });
    expect(result.text).not.toContain(KEY_FRAGMENT);
    expect(stderr()).toContain('PUT https://storage.googleapis.com/ext.gcs.opus.pro/session/[REDACTED]/obj');
    expect(stderr()).not.toContain(KEY_FRAGMENT);
  });

  it('the stderr logger removes the key, raw and JSON-escaped', async () => {
    const quotedKey = 'mcp-test-"quoted"-key';
    vi.stubEnv('OPUS_API_KEY', quotedKey);
    vi.resetModules();
    const stderr = captureStderr();
    // auth.ts registers the env key when it loads, as it does at startup.
    await import('../src/auth.js');
    const { logError } = await import('../src/key-filter.js');
    logError(`raw ${quotedKey} escaped ${JSON.stringify({ k: quotedKey })}`);
    expect(stderr()).toBe('raw [REDACTED] escaped {"k":"[REDACTED]"}');
  });
});
