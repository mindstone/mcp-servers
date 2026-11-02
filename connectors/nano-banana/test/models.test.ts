/**
 * Which Gemini model id each request goes to: the GA default, and the
 * retired preview ids still accepted and sent as their GA successor.
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

function captureModels() {
  const models: string[] = [];
  const handler = http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, ({ params }) => {
    models.push(String(params.model));
    return HttpResponse.json(createMockGeminiResponse());
  });
  return { handler, models };
}

describe('model selection', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-models-')));
    testClient = await createTestClient({
      env: { GEMINI_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '', MCP_WORKSPACE_PATH: workspaceDir },
    });
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('defaults to the GA gemini-3.1-flash-image on generate and edit', async () => {
    const { handler, models } = captureModels();
    mswServer.use(handler);
    const sourcePath = path.join(workspaceDir, 'in.png');
    fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);

    expect((await testClient.callTool('nano_banana_generate', { prompt: 'A cat' })).isError).toBeFalsy();
    expect((await testClient.callTool('nano_banana_edit', { source_image_path: sourcePath, prompt: 'make it pop' })).isError).toBeFalsy();

    expect(models).toEqual(['gemini-3.1-flash-image', 'gemini-3.1-flash-image']);
  });

  it.each([
    ['gemini-3.1-flash-image-preview', 'gemini-3.1-flash-image'],
    ['gemini-3-pro-image-preview', 'gemini-3-pro-image'],
    ['gemini-3-pro-image', 'gemini-3-pro-image'],
    ['gemini-nano-banana-2.1', 'gemini-nano-banana-2.1'],
    ['gemini-2.5-flash-image', 'gemini-2.5-flash-image'],
  ])('sends %s as %s', async (requested, sent) => {
    const { handler, models } = captureModels();
    mswServer.use(handler);

    const result = await testClient.callTool('nano_banana_generate', { prompt: 'A cat', model: requested });

    expect(result.isError).toBeFalsy();
    expect(models).toEqual([sent]);
  });

  it('sends gemini-nano-banana-2.1 on edit with a 4K image size', async () => {
    const bodies: Record<string, unknown>[] = [];
    const models: string[] = [];
    mswServer.use(http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, async ({ request, params }) => {
      models.push(String(params.model));
      bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(createMockGeminiResponse());
    }));
    const sourcePath = path.join(workspaceDir, 'in.png');
    fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: sourcePath, prompt: 'make it pop', model: 'gemini-nano-banana-2.1', image_size: '4K',
    });

    expect(result.isError).toBeFalsy();
    expect(models).toEqual(['gemini-nano-banana-2.1']);
    expect((bodies[0].generationConfig as { imageConfig?: unknown }).imageConfig).toEqual({ imageSize: '4K' });
  });

  it('still allows 2K/4K on a retired preview id (it resolves to a Gemini 3 model)', async () => {
    const { handler, models } = captureModels();
    mswServer.use(handler);

    const result = await testClient.callTool('nano_banana_generate', {
      prompt: 'A cat', model: 'gemini-3-pro-image-preview', image_size: '4K',
    });

    expect(result.isError).toBeFalsy();
    expect(models).toEqual(['gemini-3-pro-image']);
  });
});
