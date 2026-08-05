import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createKlingHandlers, mockI2vTaskId } from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { wrapUntrusted } from '../src/untrusted-content.js';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-at-least-32-chars-long';

const PNG_BYTES = Buffer.from(
  // Minimal valid PNG signature + IHDR stub — content doesn't matter, only bytes round-tripping.
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('generate_kling_image_to_video — local image input', () => {
  let testClient: McpTestClient;
  let workspace: string;
  let outside: string;

  function captureImage2vBody() {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    const handler = http.post(
      'https://api-singapore.klingai.com/v1/videos/image2video',
      async ({ request }) => {
        captured.body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          code: 0,
          message: 'success',
          data: { task_id: mockI2vTaskId },
        });
      },
    );
    return { handler, captured };
  }

  function clientEnv() {
    return {
      KLING_ACCESS_KEY: ACCESS_KEY,
      KLING_SECRET_KEY: SECRET_KEY,
      MCP_HOST_BRIDGE_STATE: '',
      MCP_WORKSPACE_PATH: workspace,
    };
  }

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-ws-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-outside-'));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* empty */ }
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* empty */ }
  });

  it('sends a workspace-local image as base64 (happy path)', async () => {
    const imagePath = path.join(workspace, 'photo.png');
    fs.writeFileSync(imagePath, PNG_BYTES);
    const { handler, captured } = captureImage2vBody();
    mswServer.use(handler);

    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_image_to_video', {
      image_path: imagePath,
      prompt: 'Camera slowly zooms in',
    });

    const json = result.json as { ok: boolean; task_id: string };
    expect(json.ok).toBe(true);
    expect(json.task_id).toBe(wrapUntrusted(mockI2vTaskId, 'kling-api'));
    expect(captured.body).toBeDefined();
    expect(captured.body!.image).toBe(PNG_BYTES.toString('base64'));
  });

  it('still accepts a public HTTPS image URL unchanged', async () => {
    const { handler, captured } = captureImage2vBody();
    mswServer.use(handler);

    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_image_to_video', {
      image_url: 'https://example.com/photo.jpg',
      prompt: 'Hair moves in breeze',
    });

    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(captured.body!.image).toBe('https://example.com/photo.jpg');
  });

  it('rejects when both image_url and image_path are given', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_image_to_video', {
      image_url: 'https://example.com/photo.jpg',
      image_path: path.join(workspace, 'photo.png'),
      prompt: 'test',
    });

    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_INPUT');
  });

  it('rejects when neither image_url nor image_path is given', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_image_to_video', {
      prompt: 'test',
    });

    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_INPUT');
  });

  it('refuses a file outside MCP_WORKSPACE_PATH before any outbound request', async () => {
    const outsideImage = path.join(outside, 'secret.png');
    fs.writeFileSync(outsideImage, PNG_BYTES);
    let requestCount = 0;
    mswServer.use(
      http.post('https://api-singapore.klingai.com/v1/videos/image2video', () => {
        requestCount++;
        return HttpResponse.json({ code: 0, message: 'success', data: { task_id: 'x' } });
      }),
    );

    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_image_to_video', {
      image_path: outsideImage,
      prompt: 'test',
    });

    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('PATH_OUTSIDE_WORKSPACE');
    expect(json.error).toContain('workspace sandbox');
    expect(requestCount).toBe(0);
  });

  it('refuses a symlink inside the workspace that points outside it', async () => {
    const outsideImage = path.join(outside, 'real.png');
    fs.writeFileSync(outsideImage, PNG_BYTES);
    const linkPath = path.join(workspace, 'link.png');
    fs.symlinkSync(outsideImage, linkPath);

    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_image_to_video', {
      image_path: linkPath,
      prompt: 'test',
    });

    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('PATH_OUTSIDE_WORKSPACE');
  });

  it('rejects unsupported file types', async () => {
    const gifPath = path.join(workspace, 'anim.gif');
    fs.writeFileSync(gifPath, PNG_BYTES);
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_image_to_video', {
      image_path: gifPath,
      prompt: 'test',
    });

    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('rejects images over the 10MB limit', async () => {
    const bigPath = path.join(workspace, 'big.png');
    fs.writeFileSync(bigPath, Buffer.alloc(11 * 1_048_576, 0x61));
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_image_to_video', {
      image_path: bigPath,
      prompt: 'test',
    });

    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('FILE_TOO_LARGE');
  });

  it('accepts a symlink inside the workspace that points to another in-workspace file', async () => {
    const realImage = path.join(workspace, 'real.png');
    fs.writeFileSync(realImage, PNG_BYTES);
    const linkPath = path.join(workspace, 'alias.png');
    fs.symlinkSync(realImage, linkPath);
    const { handler, captured } = captureImage2vBody();
    mswServer.use(handler);

    testClient = await createTestClient({ env: clientEnv() });

    const result = await testClient.callTool('generate_kling_image_to_video', {
      image_path: linkPath,
      prompt: 'test',
    });

    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(captured.body!.image).toBe(PNG_BYTES.toString('base64'));
  });

  it('falls back to the system temp directory when MCP_WORKSPACE_PATH is unset', async () => {
    const tmpImage = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kling-tmpws-')),
      'photo.jpg',
    );
    fs.writeFileSync(tmpImage, PNG_BYTES);
    const { handler, captured } = captureImage2vBody();
    mswServer.use(handler);

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: '',
      },
    });

    const result = await testClient.callTool('generate_kling_image_to_video', {
      image_path: tmpImage,
      prompt: 'test',
    });

    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(captured.body!.image).toBe(PNG_BYTES.toString('base64'));
  });
});
