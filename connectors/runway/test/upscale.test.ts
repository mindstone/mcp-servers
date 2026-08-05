import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createRunwayHandlers,
  createBodyCapturingHandlers,
  createRunwayUnauthorizedHandlers,
} from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

describe('Video upscale tool', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('upscale_video', () => {
    it('submits with defaults (2k resolution)', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('upscale_video', {
        video: 'https://example.com/clip.mp4',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-upscale-001');
      expect(data.model).toBe('magnific_video_upscaler_creative');
      expect(data.resolution).toBe('2k');

      const postBody = capturedBodies.find(c => c.url.includes('/video_upscale'))?.body as Record<string, unknown>;
      expect(postBody.model).toBe('magnific_video_upscaler_creative');
      expect(postBody.videoUri).toBe('https://example.com/clip.mp4');
      expect(postBody.resolution).toBeUndefined();
    });

    it('passes through all tuning parameters', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('upscale_video', {
        video: 'https://example.com/clip.mp4',
        resolution: '4k',
        creativity: 20,
        sharpen: 55,
        smart_grain: 10,
        flavor: 'natural',
        fps_boost: true,
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.resolution).toBe('4k');

      const postBody = capturedBodies.find(c => c.url.includes('/video_upscale'))?.body as Record<string, unknown>;
      expect(postBody.resolution).toBe('4k');
      expect(postBody.creativity).toBe(20);
      expect(postBody.sharpen).toBe(55);
      expect(postBody.smartGrain).toBe(10);
      expect(postBody.flavor).toBe('natural');
      expect(postBody.fpsBoost).toBe(true);
    });

    it('surfaces API errors as structured failures', async () => {
      mswServer.use(...createRunwayUnauthorizedHandlers());

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: 'wrong-key', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('upscale_video', {
        video: 'https://example.com/clip.mp4',
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(false);
      expect(data.code).toBe('AUTH_FAILED');
    });

    it('rejects local files outside the upload sandbox', async () => {
      mswServer.use(...createRunwayHandlers());

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('upscale_video', {
        video: '/etc/hostname',
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(false);
      expect(data.code).toBe('PATH_OUTSIDE_ALLOWED_ROOT');
    });
  });
});
