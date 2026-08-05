import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createKlingHandlers } from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-at-least-32-chars-long';

describe('Kling SSRF protection (download_kling_video)', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  const privateHosts = [
    { url: 'https://localhost/video.mp4', label: 'localhost' },
    { url: 'https://127.0.0.1/video.mp4', label: '127.0.0.1 (loopback)' },
    { url: 'https://10.0.0.1/video.mp4', label: '10.x (private class A)' },
    { url: 'https://172.16.0.1/video.mp4', label: '172.16.x (private class B)' },
    { url: 'https://192.168.1.1/video.mp4', label: '192.168.x (private class C)' },
    { url: 'https://169.254.169.254/latest/meta-data', label: '169.254.x (link-local metadata)' },
    { url: 'https://[::1]/video.mp4', label: '::1 (IPv6 loopback)' },
    { url: 'https://myhost.local/video.mp4', label: '.local domain' },
  ];

  for (const { url, label } of privateHosts) {
    it(`blocks download from ${label}`, async () => {
      mswServer.use(...createKlingHandlers());
      testClient = await createTestClient({
        env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('download_kling_video', {
        url,
        output_path: path.join(os.tmpdir(), 'kling-should-not-exist.mp4'),
      });

      const json = result.json as Record<string, unknown>;
      expect(json.ok).toBe(false);
      expect(json.error).toContain('local/private network');
    });
  }

  it('rejects non-HTTPS URLs', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('download_kling_video', {
      url: 'http://example.com/video.mp4',
      output_path: path.join(os.tmpdir(), 'kling-should-not-exist.mp4'),
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('HTTPS');
  });

  it('rejects invalid URLs', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('download_kling_video', {
      url: 'not-a-url',
      output_path: path.join(os.tmpdir(), 'kling-should-not-exist.mp4'),
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Invalid URL');
  });
});

describe('Kling download_kling_video sandbox', () => {
  const DOWNLOAD_BODY = Buffer.alloc(2048, 0xcd);
  const REPLACEMENT_BODY = Buffer.alloc(4096, 0xef);
  const REMOTE_URL = 'https://cdn.klingai.example/clip.mp4';

  let testClient: McpTestClient;
  let downloadRoot: string;
  let outsideRoot: string;
  let stubbedHome: string;

  function makeDownloadHandler(body: Buffer = DOWNLOAD_BODY) {
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
    downloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-dl-'));
    outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-dl-outside-'));
    stubbedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-home-'));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(downloadRoot, { recursive: true, force: true }); } catch { /* empty */ }
    try { fs.rmSync(outsideRoot, { recursive: true, force: true }); } catch { /* empty */ }
    try { fs.rmSync(stubbedHome, { recursive: true, force: true }); } catch { /* empty */ }
  });

  it('downloads into KLING_DOWNLOAD_ROOT (happy path)', async () => {
    const outputPath = path.join(downloadRoot, 'clip.mp4');
    const { handler, calls } = makeDownloadHandler();
    mswServer.use(...createKlingHandlers(), handler);

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        KLING_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_kling_video', {
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

  it('defaults to ~/Downloads/kling-mcp when KLING_DOWNLOAD_ROOT is unset', async () => {
    const outputPath = path.join(stubbedHome, 'Downloads', 'kling-mcp', 'clip.mp4');
    const { handler } = makeDownloadHandler();
    mswServer.use(...createKlingHandlers(), handler);

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        HOME: stubbedHome,
        USERPROFILE: stubbedHome,
        KLING_DOWNLOAD_ROOT: '',
      },
    });

    const result = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    expect(result.isError).toBeFalsy();
    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('refuses output_path outside the download root', async () => {
    const { handler, calls } = makeDownloadHandler();
    mswServer.use(...createKlingHandlers(), handler);

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        KLING_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: path.join(outsideRoot, 'clip.mp4'),
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('OUTPUT_OUTSIDE_DOWNLOAD_ROOT');
    expect(calls.length).toBe(0); // sandbox refusal happens before any network call
  });

  it('refuses .. traversal that escapes the download root', async () => {
    const { handler, calls } = makeDownloadHandler();
    mswServer.use(...createKlingHandlers(), handler);

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        KLING_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: path.join(downloadRoot, '..', 'escape.mp4'),
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('OUTPUT_OUTSIDE_DOWNLOAD_ROOT');
    expect(calls.length).toBe(0);
  });

  it('refuses to overwrite an existing file by default, clobbers with overwrite: true', async () => {
    const outputPath = path.join(downloadRoot, 'clip.mp4');
    fs.writeFileSync(outputPath, 'original');
    const { handler } = makeDownloadHandler(REPLACEMENT_BODY);
    mswServer.use(...createKlingHandlers(), handler);

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        KLING_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const refused = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: outputPath,
    });
    const refusedJson = refused.json as Record<string, unknown>;
    expect(refusedJson.ok).toBe(false);
    expect(refusedJson.code).toBe('EEXIST');
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('original');

    const allowed = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: outputPath,
      overwrite: true,
    });
    const allowedJson = allowed.json as Record<string, unknown>;
    expect(allowedJson.ok).toBe(true);
    expect(fs.readFileSync(outputPath).length).toBe(REPLACEMENT_BODY.length);
  });

  it('refuses to write through a symlink at the output target', async () => {
    const outsideFile = path.join(outsideRoot, 'real.mp4');
    fs.writeFileSync(outsideFile, 'precious');
    const linkPath = path.join(downloadRoot, 'link.mp4');
    fs.symlinkSync(outsideFile, linkPath);
    const { handler, calls } = makeDownloadHandler();
    mswServer.use(...createKlingHandlers(), handler);

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        KLING_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: linkPath,
      overwrite: true,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('OUTPUT_PATH_IS_SYMLINK');
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('precious');
    expect(calls.length).toBe(0);
  });

  it('refuses symlink-escape via the parent directory', async () => {
    const linkDir = path.join(downloadRoot, 'subdir-link');
    fs.symlinkSync(outsideRoot, linkDir);
    const { handler, calls } = makeDownloadHandler();
    mswServer.use(...createKlingHandlers(), handler);

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        KLING_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: path.join(linkDir, 'clip.mp4'),
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.code).toBe('OUTPUT_OUTSIDE_DOWNLOAD_ROOT');
    expect(calls.length).toBe(0);
  });

  it('revalidates redirect targets against the SSRF allow-list', async () => {
    const outputPath = path.join(downloadRoot, 'clip.mp4');
    mswServer.use(
      ...createKlingHandlers(),
      http.get(REMOTE_URL, () => {
        return new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://169.254.169.254/latest/meta-data' },
        });
      }),
    );

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        KLING_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('Refused to follow redirect');
    expect(fs.existsSync(outputPath)).toBe(false); // cleaned up on failure
  });

  it('reports HTTP failure and leaves no partial file', async () => {
    const outputPath = path.join(downloadRoot, 'clip.mp4');
    mswServer.use(
      ...createKlingHandlers(),
      http.get(REMOTE_URL, () => HttpResponse.text('gone', { status: 410 })),
    );

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        KLING_DOWNLOAD_ROOT: downloadRoot,
      },
    });

    const result = await testClient.callTool('download_kling_video', {
      url: REMOTE_URL,
      output_path: outputPath,
    });

    const json = result.json as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('410');
    expect(fs.existsSync(outputPath)).toBe(false);
  });
});
