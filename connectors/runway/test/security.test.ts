import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createRunwayHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

describe('Runway SSRF protection (download_runway_output)', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  const privateHosts = [
    { url: 'https://localhost/video.mp4', label: 'localhost' },
    { url: 'https://127.0.0.1/video.mp4', label: '127.0.0.1 (loopback)' },
    { url: 'https://10.0.0.1/video.mp4', label: '10.x (private class A)' },
    { url: 'https://10.255.255.255/video.mp4', label: '10.x upper bound' },
    { url: 'https://172.16.0.1/video.mp4', label: '172.16.x (private class B)' },
    { url: 'https://172.31.255.255/video.mp4', label: '172.31.x (private class B upper)' },
    { url: 'https://192.168.1.1/video.mp4', label: '192.168.x (private class C)' },
    { url: 'https://169.254.1.1/video.mp4', label: '169.254.x (link-local)' },
    { url: 'https://0.0.0.0/video.mp4', label: '0.0.0.0' },
    { url: 'https://[::1]/video.mp4', label: '::1 (IPv6 loopback)' },
    { url: 'https://myhost.local/video.mp4', label: '.local domain' },
  ];

  for (const { url, label } of privateHosts) {
    it(`blocks download from ${label}`, async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('download_runway_output', {
        url,
        output_path: '/tmp/test-output.mp4',
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.error).toContain('local/private network');
    });
  }

  it('rejects non-HTTPS URLs', async () => {
    mswServer.use(...createRunwayHandlers());
    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: 'http://example.com/video.mp4',
      output_path: '/tmp/test-output.mp4',
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('HTTPS');
  });

  it('rejects invalid URLs', async () => {
    mswServer.use(...createRunwayHandlers());
    testClient = await createTestClient({
      env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: 'not-a-url',
      output_path: '/tmp/test-output.mp4',
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Invalid URL');
  });
});

/**
 * VAL-RUNWAY-101..112 — `download_runway_output` output-path sandbox.
 *
 * Output paths must live inside RUNWAY_DOWNLOAD_ROOT (default
 * ~/Downloads/runway-mcp), with a deny-list of sensitive paths even when
 * the configured root would otherwise allow them. Default behaviour is
 * `flags: 'wx'` (refuse overwrite); explicit `overwrite: true` unlocks
 * the clobber path. Parent directory is realpathSync-checked to catch
 * symlink-escape.
 */
describe('Runway download_runway_output sandbox (VAL-RUNWAY-101..112)', () => {
  const DOWNLOAD_BODY = Buffer.alloc(2048, 0xcd); // 2 KiB of distinct bytes
  const REPLACEMENT_BODY = Buffer.alloc(4096, 0xef); // bytes that overwrite must produce
  const REMOTE_URL = 'https://cdn.runwayml.example/clip.mp4';
  const REMOTE_HOST = 'cdn.runwayml.example';

  let testClient: McpTestClient;
  let downloadRoot: string;
  let outsideRoot: string;
  let stubbedHome: string;

  // MSW handler that returns the download body for the canonical remote URL.
  function makeDownloadHandlers(body: Buffer = DOWNLOAD_BODY) {
    const calls: Array<{ url: string }> = [];
    const handler = http.get(REMOTE_URL, ({ request }) => {
      calls.push({ url: request.url });
      return HttpResponse.arrayBuffer(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) } },
      );
    });
    return { handler, calls };
  }

  beforeEach(() => {
    downloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-dl-'));
    outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-dl-outside-'));
    stubbedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-home-'));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(downloadRoot, { recursive: true, force: true }); } catch { /* empty */ }
    try { fs.rmSync(outsideRoot, { recursive: true, force: true }); } catch { /* empty */ }
    try { fs.rmSync(stubbedHome, { recursive: true, force: true }); } catch { /* empty */ }
  });

  // ── VAL-RUNWAY-101 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-101 — output_path inside RUNWAY_DOWNLOAD_ROOT succeeds', async () => {
    const outputPath = path.join(downloadRoot, 'clip.mp4');
    const { handler, calls } = makeDownloadHandlers();
    mswServer.use(...createRunwayHandlers(), handler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.path).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath).length).toBe(DOWNLOAD_BODY.length);
    expect(calls.length).toBe(1);
  });

  // ── VAL-RUNWAY-102 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-102 — default download root is ~/Downloads/runway-mcp when env unset (positive)', async () => {
    // Stub HOME so os.homedir() points at a tmp dir we control. The default
    // download root is then <stubbed-home>/Downloads/runway-mcp.
    const outputPath = path.join(stubbedHome, 'Downloads', 'runway-mcp', 'clip.mp4');
    const { handler, calls } = makeDownloadHandlers();
    mswServer.use(...createRunwayHandlers(), handler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        HOME: stubbedHome,
        USERPROFILE: stubbedHome,
        RUNWAY_DOWNLOAD_ROOT: '',
      },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('VAL-RUNWAY-102 — default download root rejects paths outside ~/Downloads/runway-mcp (negative)', async () => {
    const outsidePath = path.join(outsideRoot, 'clip.mp4');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { handler, calls } = makeDownloadHandlers();
    mswServer.use(...createRunwayHandlers(), handler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        HOME: stubbedHome,
        USERPROFILE: stubbedHome,
        RUNWAY_DOWNLOAD_ROOT: '',
      },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outsidePath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/sandbox|RUNWAY_DOWNLOAD_ROOT|outside/i);
    expect(calls.length).toBe(0);
    // No fetch call to the remote URL host (the spy may see other calls
    // from MCP setup; assert only that the download host was never hit).
    const downloadCalls = fetchSpy.mock.calls.filter((c) => {
      const u = c[0];
      return typeof u === 'string' && u.includes(REMOTE_HOST);
    });
    expect(downloadCalls.length).toBe(0);
    fetchSpy.mockRestore();
  });

  // ── VAL-RUNWAY-103 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-103 — output_path outside RUNWAY_DOWNLOAD_ROOT is refused; fetch not called', async () => {
    const outsidePath = path.join(outsideRoot, 'clip.mp4');
    const { handler, calls } = makeDownloadHandlers();
    mswServer.use(...createRunwayHandlers(), handler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outsidePath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/sandbox|RUNWAY_DOWNLOAD_ROOT|outside/i);
    expect(calls.length).toBe(0);
    expect(fs.existsSync(outsidePath)).toBe(false);
  });

  // ── VAL-RUNWAY-104 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-104 — path-traversal (..) is refused', async () => {
    const traversal = path.join(downloadRoot, '..', '..', '..', '..', '..', 'etc', 'runway.mp4');
    const { handler, calls } = makeDownloadHandlers();
    mswServer.use(...createRunwayHandlers(), handler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: traversal,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/sandbox|RUNWAY_DOWNLOAD_ROOT|outside|deny/i);
    expect(calls.length).toBe(0);
  });

  // ── VAL-RUNWAY-105 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-105 — sensitive deny-list refuses ~/.ssh/** even with $HOME root override', async () => {
    fs.mkdirSync(path.join(stubbedHome, '.ssh'), { recursive: true });
    const outputPath = path.join(stubbedHome, '.ssh', 'authorized_keys');
    const { handler, calls } = makeDownloadHandlers();
    mswServer.use(...createRunwayHandlers(), handler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        HOME: stubbedHome,
        USERPROFILE: stubbedHome,
        // Deliberately broad override that *would* otherwise allow it.
        RUNWAY_DOWNLOAD_ROOT: stubbedHome,
      },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/deny|sensitive|\.ssh/i);
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(calls.length).toBe(0);
  });

  // ── VAL-RUNWAY-106 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-106 — sensitive deny-list refuses ~/.aws/** even with $HOME root override', async () => {
    fs.mkdirSync(path.join(stubbedHome, '.aws'), { recursive: true });
    const outputPath = path.join(stubbedHome, '.aws', 'credentials');
    const { handler, calls } = makeDownloadHandlers();
    mswServer.use(...createRunwayHandlers(), handler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        HOME: stubbedHome,
        USERPROFILE: stubbedHome,
        RUNWAY_DOWNLOAD_ROOT: stubbedHome,
      },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/deny|sensitive|\.aws/i);
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(calls.length).toBe(0);
  });

  // ── VAL-RUNWAY-107 ────────────────────────────────────────────────────
  for (const rcFile of ['.bashrc', '.zshrc']) {
    it(`VAL-RUNWAY-107 — sensitive deny-list refuses ~/${rcFile} even with $HOME root override`, async () => {
      const outputPath = path.join(stubbedHome, rcFile);
      const { handler, calls } = makeDownloadHandlers();
      mswServer.use(...createRunwayHandlers(), handler);

      testClient = await createTestClient({
        env: {
          RUNWAYML_API_SECRET: MOCK_API_KEY,
          MCP_HOST_BRIDGE_STATE: '',
          HOME: stubbedHome,
          USERPROFILE: stubbedHome,
          RUNWAY_DOWNLOAD_ROOT: stubbedHome,
        },
      });

      const result = await testClient.callTool('download_runway_output', {
        url: REMOTE_URL,
        output_path: outputPath,
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(String(json.error || '')).toMatch(/deny|sensitive|rc|bashrc|zshrc/i);
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(calls.length).toBe(0);
    });
  }

  // ── VAL-RUNWAY-108 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-108 — sensitive deny-list refuses /etc/** even with `/` root override', async () => {
    const { handler, calls } = makeDownloadHandlers();
    mswServer.use(...createRunwayHandlers(), handler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        // Deliberately broad override that *would* otherwise allow it.
        RUNWAY_DOWNLOAD_ROOT: '/',
      },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: '/etc/passwd',
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/deny|sensitive|\/etc/i);
    expect(calls.length).toBe(0);
  });

  // ── VAL-RUNWAY-109 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-109 — flags: "wx" — refuses to overwrite an existing file by default', async () => {
    const outputPath = path.join(downloadRoot, 'clip.mp4');
    const preExistingBytes = Buffer.from('do not clobber me', 'utf8');
    fs.writeFileSync(outputPath, preExistingBytes);

    const { handler, calls } = makeDownloadHandlers();
    mswServer.use(...createRunwayHandlers(), handler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/exists|overwrite|EEXIST/i);
    // Pre-existing file unchanged byte-for-byte.
    expect(fs.readFileSync(outputPath).equals(preExistingBytes)).toBe(true);
  });

  // ── VAL-RUNWAY-110 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-110 — explicit overwrite: true allows clobber', async () => {
    const outputPath = path.join(downloadRoot, 'clip.mp4');
    const preExistingBytes = Buffer.from('do not clobber me', 'utf8');
    fs.writeFileSync(outputPath, preExistingBytes);

    const { handler, calls } = makeDownloadHandlers(REPLACEMENT_BODY);
    mswServer.use(...createRunwayHandlers(), handler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outputPath,
      overwrite: true,
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(calls.length).toBe(1);
    const onDisk = fs.readFileSync(outputPath);
    expect(onDisk.length).toBe(REPLACEMENT_BODY.length);
    expect(onDisk.equals(REPLACEMENT_BODY)).toBe(true);
  });

  // ── VAL-RUNWAY-111 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-111 — symlink-escape on parent directory is rejected via realpathSync', async () => {
    if (process.platform === 'win32') return;
    const symlinkPath = path.join(downloadRoot, 'escape');
    fs.symlinkSync(outsideRoot, symlinkPath);
    const outputPath = path.join(symlinkPath, 'clip.mp4');

    const { handler, calls } = makeDownloadHandlers();
    mswServer.use(...createRunwayHandlers(), handler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/sandbox|RUNWAY_DOWNLOAD_ROOT|outside|symlink/i);
    expect(calls.length).toBe(0);
    expect(fs.existsSync(path.join(outsideRoot, 'clip.mp4'))).toBe(false);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  // ── VAL-RUNWAY-112 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-112 — RUNWAY_DOWNLOAD_ROOT and deny-list are baked into source (static check)', () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const srcDir = path.resolve(here, '..', 'src');
    const collected: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts')) {
          collected.push(fs.readFileSync(full, 'utf8'));
        }
      }
    };
    walk(srcDir);
    const sourceBlob = collected.join('\n');
    expect(sourceBlob).toContain('RUNWAY_DOWNLOAD_ROOT');
    expect(sourceBlob).toMatch(/\.ssh/);
    expect(sourceBlob).toMatch(/\.aws/);
    expect(sourceBlob).toMatch(/\.bashrc/);
    expect(sourceBlob).toMatch(/\.zshrc/);
    expect(sourceBlob).toMatch(/\/etc/);
  });
});

/**
 * VAL-RUNWAY-201..209 — `download_runway_output` SSRF-via-redirect.
 *
 * `validateDownloadUrl` only inspects the initial URL. Without explicit
 * redirect handling, a public HTTPS URL can 302-redirect to a private /
 * loopback / metadata-service host and exfiltrate internal data. The fix
 * is to (a) pass `redirect: 'manual'` to fetch so the runtime never
 * silently follows a hop, (b) re-validate every `Location` header against
 * the same private-IP/scheme allow-list before following, and (c) cap the
 * redirect chain depth (≤ 5).
 */
describe('Runway download_runway_output SSRF redirect (VAL-RUNWAY-201..209)', () => {
  const DOWNLOAD_BODY = Buffer.alloc(2048, 0xcd);
  const REMOTE_URL = 'https://cdn.runwayml.example/clip.mp4';
  const REMOTE_HOST = 'cdn.runwayml.example';
  const SAFE_REDIRECT_URL = 'https://safe-cdn.example/clip.mp4';

  let testClient: McpTestClient;
  let downloadRoot: string;

  function makeRedirectHandler(locationHeader: string | null) {
    const initialCalls: Array<{ url: string; redirect: string | undefined }> = [];
    const handler = http.get(REMOTE_URL, ({ request }) => {
      // request.redirect is the Request's redirect mode (set by the caller's
      // init). msw forwards this from the underlying Request object.
      initialCalls.push({ url: request.url, redirect: (request as Request).redirect });
      const headers: Record<string, string> = {};
      if (locationHeader !== null) headers.Location = locationHeader;
      return new HttpResponse(null, { status: 302, headers });
    });
    return { handler, initialCalls };
  }

  function makeBodyHandler(url: string, body: Buffer = DOWNLOAD_BODY) {
    const calls: Array<{ url: string }> = [];
    const handler = http.get(url, ({ request }) => {
      calls.push({ url: request.url });
      return HttpResponse.arrayBuffer(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) } },
      );
    });
    return { handler, calls };
  }

  beforeEach(() => {
    downloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-dl-redir-'));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    try { fs.rmSync(downloadRoot, { recursive: true, force: true }); } catch { /* empty */ }
  });

  // ── VAL-RUNWAY-201 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-201 — passes redirect: "manual" to fetch (static check)', () => {
    const tasksTs = fs.readFileSync(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'tools', 'tasks.ts'),
      'utf8',
    );
    expect(tasksTs).toMatch(/redirect:\s*'manual'/);
  });

  it('VAL-RUNWAY-201 — passes redirect: "manual" to fetch (behavioural)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { handler: redirectHandler } = makeRedirectHandler(SAFE_REDIRECT_URL);
    const { handler: bodyHandler } = makeBodyHandler(SAFE_REDIRECT_URL);
    mswServer.use(...createRunwayHandlers(), redirectHandler, bodyHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const outputPath = path.join(downloadRoot, 'clip.mp4');
    await testClient.callTool('download_runway_output', { url: REMOTE_URL, output_path: outputPath });

    // At least one call to the download host must have been made with
    // init.redirect === 'manual'. Other fetch calls (e.g. MSW internals or
    // the connector's API client) are out of scope here.
    const downloadCalls = fetchSpy.mock.calls.filter((c) => {
      const u = c[0];
      const s = typeof u === 'string' ? u : (u as URL).toString();
      return s.includes(REMOTE_HOST) || s.includes('safe-cdn.example');
    });
    expect(downloadCalls.length).toBeGreaterThan(0);
    for (const call of downloadCalls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.redirect).toBe('manual');
    }
  });

  // ── VAL-RUNWAY-202 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-202 — 302 to a public HTTPS URL is re-validated and followed', async () => {
    const { handler: redirectHandler, initialCalls } = makeRedirectHandler(SAFE_REDIRECT_URL);
    const { handler: bodyHandler, calls: bodyCalls } = makeBodyHandler(SAFE_REDIRECT_URL);
    mswServer.use(...createRunwayHandlers(), redirectHandler, bodyHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const outputPath = path.join(downloadRoot, 'clip.mp4');
    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath).length).toBe(DOWNLOAD_BODY.length);
    expect(initialCalls.length).toBe(1);
    expect(bodyCalls.length).toBe(1);
  });

  // ── VAL-RUNWAY-203 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-203 — 302 to loopback (https://127.0.0.1/...) is refused', async () => {
    const { handler: redirectHandler, initialCalls } = makeRedirectHandler('https://127.0.0.1/x');
    mswServer.use(...createRunwayHandlers(), redirectHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const outputPath = path.join(downloadRoot, 'clip.mp4');
    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/redirect|local|private|loopback/i);
    expect(initialCalls.length).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  // ── VAL-RUNWAY-204 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-204 — 302 to AWS IMDS (169.254.169.254) is refused', async () => {
    const { handler: redirectHandler, initialCalls } = makeRedirectHandler(
      'https://169.254.169.254/latest/meta-data/',
    );
    mswServer.use(...createRunwayHandlers(), redirectHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const outputPath = path.join(downloadRoot, 'clip.mp4');
    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/redirect|local|private|link-local/i);
    expect(initialCalls.length).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  // ── VAL-RUNWAY-205 ────────────────────────────────────────────────────
  for (const target of [
    'https://10.0.0.1/x',
    'https://10.255.255.255/x',
    'https://172.16.0.1/x',
    'https://172.31.255.255/x',
    'https://192.168.1.1/x',
  ]) {
    it(`VAL-RUNWAY-205 — 302 to RFC1918 (${target}) is refused`, async () => {
      const { handler: redirectHandler, initialCalls } = makeRedirectHandler(target);
      mswServer.use(...createRunwayHandlers(), redirectHandler);

      testClient = await createTestClient({
        env: {
          RUNWAYML_API_SECRET: MOCK_API_KEY,
          MCP_HOST_BRIDGE_STATE: '',
          RUNWAY_DOWNLOAD_ROOT: downloadRoot,
        },
      });

      const outputPath = path.join(downloadRoot, 'clip.mp4');
      const result = await testClient.callTool('download_runway_output', {
        url: REMOTE_URL,
        output_path: outputPath,
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(String(json.error || '')).toMatch(/redirect|local|private/i);
      expect(initialCalls.length).toBe(1);
      expect(fs.existsSync(outputPath)).toBe(false);
    });
  }

  // ── VAL-RUNWAY-206 ────────────────────────────────────────────────────
  for (const target of [
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://[fe80::1]/x',
  ]) {
    it(`VAL-RUNWAY-206 — 302 to IPv6 (${target}) is refused`, async () => {
      const { handler: redirectHandler, initialCalls } = makeRedirectHandler(target);
      mswServer.use(...createRunwayHandlers(), redirectHandler);

      testClient = await createTestClient({
        env: {
          RUNWAYML_API_SECRET: MOCK_API_KEY,
          MCP_HOST_BRIDGE_STATE: '',
          RUNWAY_DOWNLOAD_ROOT: downloadRoot,
        },
      });

      const outputPath = path.join(downloadRoot, 'clip.mp4');
      const result = await testClient.callTool('download_runway_output', {
        url: REMOTE_URL,
        output_path: outputPath,
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(String(json.error || '')).toMatch(/redirect|local|private|loopback/i);
      expect(initialCalls.length).toBe(1);
      expect(fs.existsSync(outputPath)).toBe(false);
    });
  }

  // ── VAL-RUNWAY-207 ────────────────────────────────────────────────────
  for (const target of [
    'http://example.com/x',
    'ftp://example.com/x',
  ]) {
    it(`VAL-RUNWAY-207 — 302 to non-HTTPS (${target}) is refused`, async () => {
      const { handler: redirectHandler, initialCalls } = makeRedirectHandler(target);
      mswServer.use(...createRunwayHandlers(), redirectHandler);

      testClient = await createTestClient({
        env: {
          RUNWAYML_API_SECRET: MOCK_API_KEY,
          MCP_HOST_BRIDGE_STATE: '',
          RUNWAY_DOWNLOAD_ROOT: downloadRoot,
        },
      });

      const outputPath = path.join(downloadRoot, 'clip.mp4');
      const result = await testClient.callTool('download_runway_output', {
        url: REMOTE_URL,
        output_path: outputPath,
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(String(json.error || '')).toMatch(/redirect|HTTPS|scheme/i);
      expect(initialCalls.length).toBe(1);
      expect(fs.existsSync(outputPath)).toBe(false);
    });
  }

  // ── VAL-RUNWAY-208 ────────────────────────────────────────────────────
  it('VAL-RUNWAY-208 — 3xx with no Location header is refused gracefully', async () => {
    const { handler: redirectHandler, initialCalls } = makeRedirectHandler(null);
    mswServer.use(...createRunwayHandlers(), redirectHandler);

    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const outputPath = path.join(downloadRoot, 'clip.mp4');
    const result = await testClient.callTool('download_runway_output', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/Location|redirect/i);
    expect(initialCalls.length).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  // ── VAL-RUNWAY-209 (regression) ───────────────────────────────────────
  it('VAL-RUNWAY-209 — initial-URL SSRF table still rejects loopback (regression)', async () => {
    mswServer.use(...createRunwayHandlers());
    testClient = await createTestClient({
      env: {
        RUNWAYML_API_SECRET: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        RUNWAY_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const outputPath = path.join(downloadRoot, 'clip.mp4');
    const result = await testClient.callTool('download_runway_output', {
      url: 'https://127.0.0.1/x',
      output_path: outputPath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error || '')).toMatch(/local\/private/i);
    expect(fs.existsSync(outputPath)).toBe(false);
  });
});
