/**
 * Tool-level hardening contracts:
 *  - write-capable tools advertise destructiveHint: true
 *  - every source image is security-validated before the first network fetch
 *  - combined source-image bytes are capped per call
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, createMockGeminiResponse } from './fixtures/nano-banana-data.js';
import { MAX_COMBINED_SOURCE_IMAGE_BYTES } from '../src/tools/edit.js';
import { MAX_REMOTE_IMAGE_BYTES } from '../src/tools/remote-image.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

describe('tool annotations and fail-closed input validation', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;
  let geminiBodies: Array<Record<string, unknown>>;
  let remoteFetches: number;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-hard-')));
    geminiBodies = [];
    remoteFetches = 0;
    mswServer.use(
      http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, async ({ request }) => {
        geminiBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(createMockGeminiResponse());
      }),
      http.get('https://images.example.com/pic.png', () => {
        remoteFetches += 1;
        return new HttpResponse(ONE_PIXEL_PNG, {
          headers: { 'Content-Type': 'image/png', 'Content-Length': String(ONE_PIXEL_PNG.length) },
        });
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
    // Point DNS at a public IP for the fake remote host (see
    // edit-remote-url.test.ts for why this runs after client creation).
    const { setDnsLookupForTesting } = await import('../src/tools/remote-image.js');
    setDnsLookupForTesting(async () => [{ address: '93.184.216.34', family: 4 }]);
  }

  it('generate and edit advertise destructiveHint: true (they write files)', async () => {
    await makeClient();
    const toolsResult = await testClient.client.listTools();
    const byName = new Map(toolsResult.tools.map((t) => [t.name, t]));

    expect(byName.get('nano_banana_generate')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('nano_banana_edit')?.annotations?.destructiveHint).toBe(true);
  });

  it('validates ALL sources before the first network fetch', async () => {
    await makeClient();

    // First source is a fetchable remote URL; the second is invalid. The
    // whole input must fail closed WITHOUT fetching the first entry.
    const result = await testClient.callTool('nano_banana_edit', {
      source_image_paths: ['https://images.example.com/pic.png', 'http://insecure.example.com/pic.png'],
      prompt: 'combine',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('URL_REJECTED');
    expect(remoteFetches).toBe(0);
    expect(geminiBodies).toHaveLength(0);
  });

  it('enforces the combined source-image byte cap across local files', async () => {
    await makeClient();

    // Three files each under every per-file limit, over the combined cap.
    const perFile = Math.floor(MAX_COMBINED_SOURCE_IMAGE_BYTES / 3) + 1024;
    const big = Buffer.alloc(perFile, 0x41);
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(workspaceDir, `big-${i}.png`);
      fs.writeFileSync(p, big);
      paths.push(p);
    }

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_paths: paths,
      prompt: 'combine',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('SOURCE_IMAGES_TOO_LARGE');
    expect(geminiBodies).toHaveLength(0);
  });

  it('enforces the per-image byte cap on a LOCAL source file (parity with remote fetches)', async () => {
    await makeClient();

    // One local file over the per-image limit: refused from its fstat size
    // without shipping anything to Gemini.
    const oversized = path.join(workspaceDir, 'huge.png');
    fs.writeFileSync(oversized, Buffer.alloc(MAX_REMOTE_IMAGE_BYTES + 1, 0x41));

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: oversized,
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('SOURCE_IMAGE_TOO_LARGE');
    expect(geminiBodies).toHaveLength(0);
  });
});
