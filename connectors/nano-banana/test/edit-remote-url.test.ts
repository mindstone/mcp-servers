/**
 * Remote (https://) source-image support for `nano_banana_edit`:
 * happy path, SSRF guards, content-type and size enforcement.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, createMockGeminiResponse } from './fixtures/nano-banana-data.js';
import { MAX_REMOTE_IMAGE_BYTES } from '../src/tools/remote-image.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

function pngResponse(body: Buffer = ONE_PIXEL_PNG) {
  return new HttpResponse(body, {
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) },
  });
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

describe('nano_banana_edit — remote source image URLs', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;
  let geminiBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-remote-')));
    geminiBodies = [];
    mswServer.use(
      http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, async ({ request }) => {
        geminiBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(createMockGeminiResponse());
      }),
    );
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function makeClient() {
    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });
    // The SSRF guard resolves hostnames via DNS; the *.example.com hosts in
    // these tests don't exist, so point every lookup at a public IP. Must run
    // AFTER createTestClient — its vi.resetModules() re-imports the module,
    // and this dynamic import lands on the same fresh instance the server uses.
    const { setDnsLookupForTesting } = await import('../src/tools/remote-image.js');
    setDnsLookupForTesting(async () => [{ address: '93.184.216.34', family: 4 }]);
  }

  function imageParts(body: Record<string, unknown>): GeminiPart[] {
    const contents = body.contents as Array<{ parts: GeminiPart[] }>;
    return contents[0].parts.filter((p) => p.inlineData);
  }

  it('fetches an https:// source image and forwards it inline to Gemini', async () => {
    mswServer.use(http.get('https://images.example.com/pic.png', () => pngResponse()));
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: 'https://images.example.com/pic.png',
      prompt: 'rotate',
    });

    expect(result.isError).toBeFalsy();
    expect(geminiBodies).toHaveLength(1);
    expect(imageParts(geminiBodies[0])[0].inlineData).toEqual({
      mimeType: 'image/png',
      data: ONE_PIXEL_PNG.toString('base64'),
    });
  });

  it('mixes remote URLs and local files in one multi-image edit', async () => {
    mswServer.use(http.get('https://images.example.com/pic.webp', () =>
      new HttpResponse(ONE_PIXEL_PNG, { headers: { 'Content-Type': 'image/webp' } }),
    ));
    await makeClient();

    const localPath = path.join(workspaceDir, 'local.png');
    fs.writeFileSync(localPath, ONE_PIXEL_PNG);

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_paths: [localPath, 'https://images.example.com/pic.webp'],
      prompt: 'combine',
    });

    expect(result.isError).toBeFalsy();
    const images = imageParts(geminiBodies[0]);
    expect(images.map((p) => p.inlineData?.mimeType)).toEqual(['image/png', 'image/webp']);
  });

  it('follows a redirect after re-validating the target host', async () => {
    mswServer.use(
      http.get('https://images.example.com/redir.png', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://cdn.example.com/final.png' },
        }),
      ),
      http.get('https://cdn.example.com/final.png', () => pngResponse()),
    );
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: 'https://images.example.com/redir.png',
      prompt: 'rotate',
    });

    expect(result.isError).toBeFalsy();
    expect(geminiBodies).toHaveLength(1);
  });

  it('refuses plain http:// URLs', async () => {
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: 'http://images.example.com/pic.png',
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('URL_REJECTED');
    expect(result.text).toMatch(/https/i);
    expect(geminiBodies).toHaveLength(0);
  });

  it('refuses private/loopback/link-local hosts (SSRF guard)', async () => {
    await makeClient();

    for (const url of [
      'https://169.254.169.254/latest/meta-data.png',
      'https://127.0.0.1/internal.png',
      'https://localhost/pic.png',
      'https://192.168.1.1/router.png',
    ]) {
      const result = await testClient.callTool('nano_banana_edit', {
        source_image_path: url,
        prompt: 'rotate',
      });
      expect(result.isError, url).toBe(true);
      expect(result.text, url).toContain('URL_REJECTED');
    }
    expect(geminiBodies).toHaveLength(0);
  });

  it('refuses URLs with embedded credentials', async () => {
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: 'https://user:pass@images.example.com/pic.png',
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('URL_REJECTED');
    expect(geminiBodies).toHaveLength(0);
  });

  it('refuses a redirect that downgrades to http://', async () => {
    mswServer.use(
      http.get('https://images.example.com/redir.png', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'http://images.example.com/final.png' },
        }),
      ),
    );
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: 'https://images.example.com/redir.png',
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('URL_REJECTED');
    expect(geminiBodies).toHaveLength(0);
  });

  it('refuses a redirect to a private host', async () => {
    mswServer.use(
      http.get('https://images.example.com/redir.png', () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'https://169.254.169.254/steal.png' },
        }),
      ),
    );
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: 'https://images.example.com/redir.png',
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('URL_REJECTED');
    expect(geminiBodies).toHaveLength(0);
  });

  it('rejects non-image Content-Type responses', async () => {
    mswServer.use(http.get('https://images.example.com/page', () =>
      new HttpResponse('<html>not an image</html>', { headers: { 'Content-Type': 'text/html' } }),
    ));
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: 'https://images.example.com/page',
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('REMOTE_IMAGE_NOT_IMAGE');
    expect(geminiBodies).toHaveLength(0);
  });

  it('rejects an oversized image via its Content-Length header', async () => {
    mswServer.use(http.get('https://images.example.com/huge.png', () =>
      new HttpResponse(ONE_PIXEL_PNG, {
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(MAX_REMOTE_IMAGE_BYTES + 1),
        },
      }),
    ));
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: 'https://images.example.com/huge.png',
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('REMOTE_IMAGE_TOO_LARGE');
    expect(geminiBodies).toHaveLength(0);
  });

  it('caps the download while streaming when Content-Length lies', async () => {
    const oversized = Buffer.alloc(MAX_REMOTE_IMAGE_BYTES + 1, 0x41);
    mswServer.use(http.get('https://images.example.com/lying.png', () =>
      new HttpResponse(oversized, { headers: { 'Content-Type': 'image/png' } }),
    ));
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: 'https://images.example.com/lying.png',
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('REMOTE_IMAGE_TOO_LARGE');
    expect(geminiBodies).toHaveLength(0);
  });

  it('maps upstream HTTP errors to REMOTE_IMAGE_FETCH_FAILED', async () => {
    mswServer.use(http.get('https://images.example.com/missing.png', () =>
      new HttpResponse('not found', { status: 404 }),
    ));
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: 'https://images.example.com/missing.png',
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('REMOTE_IMAGE_FETCH_FAILED');
    expect(result.text).toContain('404');
    expect(geminiBodies).toHaveLength(0);
  });
});
