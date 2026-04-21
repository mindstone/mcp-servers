import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createKlingHandlers, mockTaskId, mockI2vTaskId } from './helpers/kling-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';

const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key-at-least-32-chars-long';

describe('Kling video tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('generate_kling_video', () => {
    it('starts video generation and returns task_id', async () => {
      mswServer.use(...createKlingHandlers());
      testClient = await createTestClient({
        env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_kling_video', {
        prompt: 'A golden retriever playing in autumn leaves, cinematic lighting',
      });
      const json = result.json as { ok: boolean; task_id: string; task_type: string };
      expect(json.ok).toBe(true);
      expect(json.task_id).toBe(mockTaskId);
      expect(json.task_type).toBe('text2video');
    });

    it('sends correct model and parameters in request body', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      mswServer.use(
        http.post('https://api-singapore.klingai.com/v1/videos/text2video', async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            code: 0,
            message: 'success',
            data: { task_id: mockTaskId },
          });
        }),
      );

      testClient = await createTestClient({
        env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.callTool('generate_kling_video', {
        prompt: 'City skyline timelapse',
        model: 'kling-v2-master',
        aspect_ratio: '9:16',
        duration: '10',
        mode: 'pro',
      });

      expect(capturedBody).toBeDefined();
      expect(capturedBody!.model_name).toBe('kling-v2-master');
      expect(capturedBody!.aspect_ratio).toBe('9:16');
      expect(capturedBody!.duration).toBe('10');
      expect(capturedBody!.mode).toBe('pro');
    });

    it('sends JWT Bearer token in Authorization header', async () => {
      let capturedAuthHeader: string | null = null;
      mswServer.use(
        http.post('https://api-singapore.klingai.com/v1/videos/text2video', async ({ request }) => {
          capturedAuthHeader = request.headers.get('Authorization');
          return HttpResponse.json({
            code: 0,
            message: 'success',
            data: { task_id: mockTaskId },
          });
        }),
      );

      testClient = await createTestClient({
        env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.callTool('generate_kling_video', { prompt: 'test' });

      expect(capturedAuthHeader).toBeDefined();
      expect(capturedAuthHeader).toMatch(/^Bearer /);
      // JWT has 3 parts separated by dots
      const token = capturedAuthHeader!.replace('Bearer ', '');
      const parts = token.split('.');
      expect(parts).toHaveLength(3);

      // Verify JWT header has correct alg
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      expect(header.alg).toBe('HS256');
      expect(header.typ).toBe('JWT');

      // Verify JWT payload has correct iss (access key)
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      expect(payload.iss).toBe(ACCESS_KEY);
      expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('fails without credentials configured', async () => {
      mswServer.use(...createKlingHandlers());
      testClient = await createTestClient({
        env: { KLING_ACCESS_KEY: '', KLING_SECRET_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_kling_video', { prompt: 'test' });
      expect(result.isError).toBe(true);
      const json = result.json as { ok: boolean; error: string; code: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('not configured');
    });
  });

  describe('generate_kling_image_to_video', () => {
    it('starts image-to-video generation and returns task_id', async () => {
      mswServer.use(...createKlingHandlers());
      testClient = await createTestClient({
        env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_kling_image_to_video', {
        image_url: 'https://example.com/photo.jpg',
        prompt: 'Camera slowly zooms in, hair moves in breeze',
      });
      const json = result.json as { ok: boolean; task_id: string; task_type: string };
      expect(json.ok).toBe(true);
      expect(json.task_id).toBe(mockI2vTaskId);
      expect(json.task_type).toBe('image2video');
    });

    it('rejects non-HTTPS image URLs via Zod', async () => {
      mswServer.use(...createKlingHandlers());
      testClient = await createTestClient({
        env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_kling_image_to_video', {
        image_url: 'not-a-url',
        prompt: 'test',
      });
      // Zod validation will reject invalid URL
      expect(result.isError).toBe(true);
    });
  });

  describe('check_kling_task', () => {
    it('returns completed status with video URL', async () => {
      mswServer.use(...createKlingHandlers());
      testClient = await createTestClient({
        env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('check_kling_task', {
        task_id: mockTaskId,
        task_type: 'text2video',
      });
      const json = result.json as { ok: boolean; task_id: string; status: string; video: { url: string; duration: string } };
      expect(json.ok).toBe(true);
      expect(json.status).toBe('succeed');
      expect(json.video).toBeDefined();
      expect(json.video.url).toContain('klingai.com');
    });

    it('returns processing status with poll hint', async () => {
      mswServer.use(
        http.get('https://api-singapore.klingai.com/v1/videos/text2video/:taskId', () => {
          return HttpResponse.json({
            code: 0,
            message: 'success',
            data: {
              task_id: 'processing-task',
              task_status: 'processing',
              task_status_msg: 'Video is being generated',
            },
          });
        }),
      );

      testClient = await createTestClient({
        env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('check_kling_task', {
        task_id: 'processing-task',
        task_type: 'text2video',
      });
      const json = result.json as { ok: boolean; status: string; nextPollSeconds: number };
      expect(json.ok).toBe(true);
      expect(json.status).toBe('processing');
      expect(json.nextPollSeconds).toBe(20);
    });

    it('returns failed status with resolution', async () => {
      mswServer.use(
        http.get('https://api-singapore.klingai.com/v1/videos/text2video/:taskId', () => {
          return HttpResponse.json({
            code: 0,
            message: 'success',
            data: {
              task_id: 'failed-task',
              task_status: 'failed',
              task_status_msg: 'Content policy violation',
            },
          });
        }),
      );

      testClient = await createTestClient({
        env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('check_kling_task', {
        task_id: 'failed-task',
        task_type: 'text2video',
      });
      const json = result.json as { ok: boolean; status: string; resolution: string };
      expect(json.ok).toBe(false);
      expect(json.status).toBe('failed');
      expect(json.resolution).toBeDefined();
    });

    it('returns error for invalid task ID', async () => {
      mswServer.use(...createKlingHandlers());
      testClient = await createTestClient({
        env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('check_kling_task', {
        task_id: 'nonexistent-task',
        task_type: 'text2video',
      });
      expect(result.isError).toBe(true);
    });
  });
});

describe('Kling error handling', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('invalid credentials return isError without leaking secrets', async () => {
    mswServer.use(
      http.post('https://api-singapore.klingai.com/v1/videos/text2video', () => {
        return HttpResponse.json(
          { code: 1000, message: 'Unauthorized', data: null },
          { status: 401 },
        );
      }),
    );

    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('generate_kling_video', { prompt: 'test' });
    expect(result.isError).toBe(true);
    const text = result.text;
    // Ensure secrets are not in the error output
    expect(text).not.toContain(ACCESS_KEY);
    expect(text).not.toContain(SECRET_KEY);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Authentication failed');
  });

  it('malformed input rejected by Zod before outbound request', async () => {
    let requestCount = 0;
    mswServer.use(
      http.post('https://api-singapore.klingai.com/v1/videos/text2video', () => {
        requestCount++;
        return HttpResponse.json({
          code: 0,
          message: 'success',
          data: { task_id: 'task-123' },
        });
      }),
    );

    testClient = await createTestClient({
      env: { KLING_ACCESS_KEY: ACCESS_KEY, KLING_SECRET_KEY: SECRET_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    // Empty prompt should be rejected by Zod (min 1)
    const result = await testClient.callTool('generate_kling_video', { prompt: '' });
    expect(result.isError).toBe(true);
    expect(requestCount).toBe(0);
  });

  it('network timeout returns actionable MCP error (uses KLING_REQUEST_TIMEOUT_MS override)', async () => {
    mswServer.use(
      http.post('https://api-singapore.klingai.com/v1/videos/text2video', async () => {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return HttpResponse.json({});
      }),
    );

    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: ACCESS_KEY,
        KLING_SECRET_KEY: SECRET_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        // Short timeout so the test aborts fast; default is 60s.
        KLING_REQUEST_TIMEOUT_MS: '500',
      },
    });

    const result = await testClient.callTool('generate_kling_video', { prompt: 'timeout test' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(result.text).toContain('timed out');
    expect(result.text).toContain('KLING_REQUEST_TIMEOUT_MS');
    // Should not contain secrets
    expect(result.text).not.toContain(ACCESS_KEY);
    expect(result.text).not.toContain(SECRET_KEY);
  });

  it('ignores invalid KLING_REQUEST_TIMEOUT_MS and falls back to default', async () => {
    // When the env var is invalid the module should load cleanly and use the default.
    // We assert this indirectly via AUTH_REQUIRED: missing keys → connector still initialises.
    testClient = await createTestClient({
      env: {
        KLING_ACCESS_KEY: '',
        KLING_SECRET_KEY: '',
        MCP_HOST_BRIDGE_STATE: '',
        KLING_REQUEST_TIMEOUT_MS: 'not-a-number',
      },
    });

    const result = await testClient.callTool('generate_kling_video', { prompt: 'test' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('AUTH_REQUIRED');
  });
});
