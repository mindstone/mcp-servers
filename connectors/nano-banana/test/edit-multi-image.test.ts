/**
 * Multi-image input tests for `nano_banana_edit`
 * (source_image_paths / combined with source_image_path).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, createMockGeminiResponse } from './fixtures/nano-banana-data.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

function captureRequestBodies() {
  const bodies: Array<Record<string, unknown>> = [];
  const handlers = [
    http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(createMockGeminiResponse());
    }),
  ];
  return { handlers, bodies };
}

function partsOf(body: Record<string, unknown>): GeminiPart[] {
  const contents = body.contents as Array<{ parts: GeminiPart[] }>;
  return contents[0].parts;
}

describe('nano_banana_edit — multi-image input', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-multi-ws-')));
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-multi-out-')));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function makeClient() {
    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });
  }

  function writeImage(name: string, dir = workspaceDir): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, ONE_PIXEL_PNG);
    return p;
  }

  it('sends every image in source_image_paths as its own inlineData part', async () => {
    const { handlers, bodies } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const a = writeImage('a.png');
    const b = writeImage('b.jpg');

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_paths: [a, b],
      prompt: 'combine these',
    });

    expect(result.isError).toBeFalsy();
    expect(bodies).toHaveLength(1);
    const parts = partsOf(bodies[0]);
    expect(parts).toHaveLength(3);
    expect(parts[0].text).toBe('Edit these images: combine these');
    expect(parts[1].inlineData).toEqual({
      mimeType: 'image/png',
      data: ONE_PIXEL_PNG.toString('base64'),
    });
    expect(parts[2].inlineData?.mimeType).toBe('image/jpeg');
  });

  it('combines source_image_path and source_image_paths (legacy single + array)', async () => {
    const { handlers, bodies } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const a = writeImage('a.png');
    const b = writeImage('b.png');
    const c = writeImage('c.webp');

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: a,
      source_image_paths: [b, c],
      prompt: 'merge all three',
    });

    expect(result.isError).toBeFalsy();
    const parts = partsOf(bodies[0]);
    expect(parts).toHaveLength(4);
    expect(parts[3].inlineData?.mimeType).toBe('image/webp');
  });

  it('keeps the single-image prompt framing for one source (back-compat)', async () => {
    const { handlers, bodies } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const a = writeImage('a.png');

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: a,
      prompt: 'rotate',
    });

    expect(result.isError).toBeFalsy();
    expect(partsOf(bodies[0])[0].text).toBe('Edit this image: rotate');
  });

  it('errors when no source image is provided at all', async () => {
    const { handlers, bodies } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', { prompt: 'rotate' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('No source image');
    expect(bodies).toHaveLength(0);
  });

  it('rejects more than 14 combined source images before calling the API', async () => {
    const { handlers, bodies } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const single = writeImage('single.png');
    const many = Array.from({ length: 14 }, (_, i) => writeImage(`ref-${i}.png`));

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: single,
      source_image_paths: many,
      prompt: 'combine everything',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Too many source images');
    expect(bodies).toHaveLength(0);
  });

  it('rejects an out-of-workspace path inside source_image_paths (sandbox still applies)', async () => {
    const { handlers, bodies } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const inside = writeImage('ok.png');
    const outside = writeImage('secret.png', outsideDir);

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_paths: [inside, outside],
      prompt: 'combine',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/workspace|sandbox|outside/i);
    expect(bodies).toHaveLength(0);
  });

  it('rejects an empty source_image_paths array via Zod', async () => {
    const { handlers, bodies } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_paths: [],
      prompt: 'rotate',
    });

    expect(result.isError).toBe(true);
    expect(bodies).toHaveLength(0);
  });
});
