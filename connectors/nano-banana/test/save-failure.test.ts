/**
 * Save-path behaviour for `nano_banana_generate` / `nano_banana_edit`:
 * a failed save must surface as SAVE_FAILED (never silent success),
 * with the generated image still returned inline.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mswServer } from './helpers/setup.js';
import { createNanoBananaHandlers } from './helpers/nano-banana-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/nano-banana-data.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

describe('save_path handling', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-save-')));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function makeClient() {
    mswServer.use(...createNanoBananaHandlers());
    testClient = await createTestClient({
      env: {
        GEMINI_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });
  }

  it('generate: saves the image inside the workspace (happy path)', async () => {
    await makeClient();

    const result = await testClient.callTool('nano_banana_generate', {
      prompt: 'A cat',
      save_path: 'out/saved-image',
    });

    expect(result.isError).toBeFalsy();
    const saved = path.join(workspaceDir, 'out', 'saved-image.png');
    expect(fs.existsSync(saved)).toBe(true);
    expect(result.text).toContain(saved);
  });

  it('generate: a failed save returns SAVE_FAILED and keeps the image inline', async () => {
    await makeClient();
    // A regular file where the save directory should be — mkdirSync fails.
    fs.writeFileSync(path.join(workspaceDir, 'blocker'), 'not a directory');

    const result = await testClient.callTool('nano_banana_generate', {
      prompt: 'A cat',
      save_path: 'blocker/out.png',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('SAVE_FAILED');
    expect(result.text).not.toContain('Image generated and saved to');
    const imageContent = result.content.find((c: { type: string }) => c.type === 'image');
    expect(imageContent).toBeDefined();
  });

  it('edit: a failed save returns SAVE_FAILED and keeps the image inline', async () => {
    await makeClient();
    const sourcePath = path.join(workspaceDir, 'in.png');
    fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);
    fs.writeFileSync(path.join(workspaceDir, 'blocker'), 'not a directory');

    const result = await testClient.callTool('nano_banana_edit', {
      source_image_path: sourcePath,
      prompt: 'rotate',
      save_path: 'blocker/out.png',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('SAVE_FAILED');
    const imageContent = result.content.find((c: { type: string }) => c.type === 'image');
    expect(imageContent).toBeDefined();
  });
});
