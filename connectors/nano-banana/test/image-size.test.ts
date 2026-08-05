/**
 * Tests for the `image_size` parameter (imageConfig.imageSize) on
 * `nano_banana_generate` and `nano_banana_edit`.
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

interface CapturedRequest {
  model: string;
  body: Record<string, unknown>;
}

/** MSW handlers that record every Gemini request body for assertion. */
function captureRequestBodies() {
  const captured: CapturedRequest[] = [];
  const handlers = [
    http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, async ({ request, params }) => {
      captured.push({
        model: String(params.model),
        body: (await request.json()) as Record<string, unknown>,
      });
      return HttpResponse.json(createMockGeminiResponse());
    }),
  ];
  return { handlers, captured };
}

describe('image_size parameter', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-imgsize-')));
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
  }

  it('omits imageConfig entirely when neither aspect_ratio nor image_size is given', async () => {
    const { handlers, captured } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const result = await testClient.callTool('nano_banana_generate', { prompt: 'A cat' });

    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
    const generationConfig = captured[0].body.generationConfig as Record<string, unknown>;
    expect(generationConfig.imageConfig).toBeUndefined();
  });

  it('forwards image_size (and aspect_ratio) as imageConfig on generate', async () => {
    const { handlers, captured } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const result = await testClient.callTool('nano_banana_generate', {
      prompt: 'A wide landscape',
      aspect_ratio: '16:9',
      image_size: '2K',
    });

    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
    const generationConfig = captured[0].body.generationConfig as {
      imageConfig?: { aspectRatio?: string; imageSize?: string };
    };
    expect(generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '2K' });
  });

  it('forwards image_size as imageConfig on edit', async () => {
    const { handlers, captured } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const sourcePath = path.join(workspaceDir, 'in.png');
    fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: sourcePath,
      prompt: 'make it pop',
      image_size: '4K',
    });

    expect(result.isError).toBeFalsy();
    expect(captured).toHaveLength(1);
    const generationConfig = captured[0].body.generationConfig as {
      imageConfig?: { aspectRatio?: string; imageSize?: string };
    };
    expect(generationConfig.imageConfig).toEqual({ imageSize: '4K' });
  });

  it('rejects image_size for gemini-2.5-flash-image without calling the API', async () => {
    const { handlers, captured } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const result = await testClient.callTool('nano_banana_generate', {
      prompt: 'A cat',
      model: 'gemini-2.5-flash-image',
      image_size: '2K',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('UNSUPPORTED_IMAGE_SIZE');
    expect(captured).toHaveLength(0);
  });

  it('rejects an invalid image_size value via Zod before any request', async () => {
    const { handlers, captured } = captureRequestBodies();
    mswServer.use(...handlers);
    await makeClient();

    const result = await testClient.callTool('nano_banana_generate', {
      prompt: 'A cat',
      image_size: '8K',
    });

    expect(result.isError).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it('exports image_size as an enum in both tools/list schemas', async () => {
    mswServer.use(...captureRequestBodies().handlers);
    await makeClient();

    const toolsResult = await testClient.client.listTools();
    for (const name of ['nano_banana_generate', 'nano_banana_edit']) {
      const tool = toolsResult.tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      const properties = (tool!.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties;
      expect(properties?.image_size?.enum).toEqual(['1K', '2K', '4K']);
    }
  });
});
