import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createKlingHandlers, mockImageTaskId } from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { wrapUntrusted } from '../src/untrusted-content.js';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-at-least-32-chars-long';

const BASE = 'https://api-singapore.klingai.com/v1';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('generate_kling_image', () => {
  let testClient: McpTestClient;
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kling-img-ws-'));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* empty */ }
  });

  function captureImageGen() {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    const handler = http.post(`${BASE}/images/generations`, async ({ request }) => {
      captured.body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ code: 0, message: 'success', data: { task_id: mockImageTaskId } });
    });
    return { handler, captured };
  }

  it('submits a text-only image task (happy path)', async () => {
    const { handler, captured } = captureImageGen();
    mswServer.use(handler);
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('generate_kling_image', {
      prompt: 'A minimalist product photo of a ceramic mug on a wooden table',
      model: 'kling-v2',
      aspect_ratio: '1:1',
      n: 3,
    });

    const json = result.json as { ok: boolean; task_id: string; task_type: string };
    expect(json.ok).toBe(true);
    expect(json.task_id).toBe(wrapUntrusted(mockImageTaskId, 'kling-api'));
    expect(json.task_type).toBe('image');
    expect(captured.body).toBeDefined();
    expect(captured.body!.model_name).toBe('kling-v2');
    expect(captured.body!.aspect_ratio).toBe('1:1');
    expect(captured.body!.n).toBe(3);
    expect(captured.body!.image).toBeUndefined();
  });

  it('sends a workspace-local reference image as base64', async () => {
    const refPath = path.join(workspace, 'ref.png');
    fs.writeFileSync(refPath, PNG_BYTES);
    const { handler, captured } = captureImageGen();
    mswServer.use(handler);
    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspace,
      },
    });

    const result = await testClient.callTool('generate_kling_image', {
      prompt: 'Same mug, but on a marble countertop',
      image_path: refPath,
    });

    const json = result.json as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(captured.body!.image).toBe(PNG_BYTES.toString('base64'));
  });

  it('rejects both image_url and image_path together', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('generate_kling_image', {
      prompt: 'test',
      image_url: 'https://example.com/ref.png',
      image_path: path.join(workspace, 'ref.png'),
    });

    const json = result.json as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('INVALID_INPUT');
  });

  it('check_kling_task resolves an image task and lists image URLs', async () => {
    mswServer.use(...createKlingHandlers());
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('check_kling_task', {
      task_id: mockImageTaskId,
      task_type: 'image',
    });

    const json = result.json as {
      ok: boolean;
      status: string;
      images: Array<{ url: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.status).toBe('succeed');
    expect(json.images).toHaveLength(2);
    expect(json.images[0].url).toContain('klingai.com');
  });

  it('surfaces API errors with the standard contract', async () => {
    mswServer.use(
      http.post(`${BASE}/images/generations`, () => {
        return HttpResponse.json(
          { code: 1102, message: 'Insufficient balance', data: null },
          { status: 429 },
        );
      }),
    );
    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('generate_kling_image', { prompt: 'test' });

    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; code: string; resolution: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe('KLING_1102');
    expect(json.resolution).toContain('credits');
  });
});
