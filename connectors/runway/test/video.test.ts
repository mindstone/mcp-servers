import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createRunwayHandlers, createBodyCapturingHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

describe('Video generation tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('generate_video_from_text', () => {
    it('submits with correct model and params', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_video_from_text', {
        prompt_text: 'A golden retriever running through autumn leaves',
        model: 'veo3.1',
        duration: 4,
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-text2vid-001');
      expect(data.model).toBe('veo3.1');

      const postBody = capturedBodies.find(c => c.url.includes('/text_to_video'))?.body as Record<string, unknown>;
      expect(postBody).toBeDefined();
      expect(postBody.model).toBe('veo3.1');
      expect(postBody.duration).toBe(4);
    });

    it('sends content_moderation when specified', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.callTool('generate_video_from_text', {
        prompt_text: 'A famous person giving a speech',
        model: 'gen4.5',
        content_moderation: 'low',
      });

      const postBody = capturedBodies.find(c => c.url.includes('/text_to_video'))?.body as Record<string, unknown>;
      expect(postBody.contentModeration).toEqual({ publicFigureThreshold: 'low' });
    });

    it('sends negative_prompt for veo models', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_video_from_text', {
        prompt_text: 'A calm beach at sunset',
        model: 'veo3.1',
        negative_prompt: 'people, text, watermark',
      });

      expect(result.isError).toBeFalsy();
      const postBody = capturedBodies.find(c => c.url.includes('/text_to_video'))?.body as Record<string, unknown>;
      expect(postBody.negativePrompt).toBe('people, text, watermark');
    });

    it('omits negative_prompt for gen4.5 (unsupported upstream)', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.callTool('generate_video_from_text', {
        prompt_text: 'A calm beach at sunset',
        model: 'gen4.5',
        negative_prompt: 'people',
      });

      const postBody = capturedBodies.find(c => c.url.includes('/text_to_video'))?.body as Record<string, unknown>;
      expect(postBody.negativePrompt).toBeUndefined();
    });

  });

  describe('generate_video_from_image', () => {
    it('submits with single image (first keyframe)', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_video_from_image', {
        prompt_image: 'https://example.com/photo.jpg',
        prompt_text: 'Camera slowly pans right',
        model: 'gen4_turbo',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-img2vid-001');
      expect(data.keyframes).toBe('first');

      const postBody = capturedBodies.find(c => c.url.includes('/image_to_video'))?.body as Record<string, unknown>;
      expect(postBody.promptImage).toBe('https://example.com/photo.jpg');
    });

    it('submits keyframe array when last_frame_image provided', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_video_from_image', {
        prompt_image: 'https://example.com/start.jpg',
        last_frame_image: 'https://example.com/end.jpg',
        prompt_text: 'Smooth transition between scenes',
        model: 'gen4.5',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.keyframes).toBe('first+last');

      const postBody = capturedBodies.find(c => c.url.includes('/image_to_video'))?.body as Record<string, unknown>;
      const promptImage = postBody.promptImage as Array<{ uri: string; position: string }>;
      expect(Array.isArray(promptImage)).toBe(true);
      expect(promptImage).toHaveLength(2);
      expect(promptImage[0]).toEqual({ uri: 'https://example.com/start.jpg', position: 'first' });
      expect(promptImage[1]).toEqual({ uri: 'https://example.com/end.jpg', position: 'last' });
    });

    it('sends negative_prompt for veo models', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_video_from_image', {
        prompt_image: 'https://example.com/photo.jpg',
        prompt_text: 'Gentle waves rolling in',
        model: 'veo3.1_fast',
        negative_prompt: 'boats, birds',
      });

      expect(result.isError).toBeFalsy();
      const postBody = capturedBodies.find(c => c.url.includes('/image_to_video'))?.body as Record<string, unknown>;
      expect(postBody.negativePrompt).toBe('boats, birds');
    });

  });

  describe('generate_video_from_video', () => {
    it('submits with video URL and prompt', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_video_from_video', {
        video: 'https://example.com/input.mp4',
        prompt_text: 'Transform into anime style',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-vid2vid-001');
      expect(data.model).toBe('aleph2');

      const postBody = capturedBodies.find(c => c.url.includes('/video_to_video'))?.body as Record<string, unknown>;
      expect(postBody.model).toBe('aleph2');
    });

    it('maps reference_image to an aleph2 keyframe at second 0', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_video_from_video', {
        video: 'https://example.com/input.mp4',
        prompt_text: 'Make it look like a watercolor painting',
        reference_image: 'https://example.com/style.jpg',
      });

      expect(result.isError).toBeFalsy();
      const postBody = capturedBodies.find(c => c.url.includes('/video_to_video'))?.body as Record<string, unknown>;
      expect(postBody.keyframes).toEqual([{ uri: 'https://example.com/style.jpg', seconds: 0 }]);
      expect(postBody.references).toBeUndefined();
    });
  });

  describe('character_performance', () => {
    it('submits with character and reference video', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('character_performance', {
        character: 'https://example.com/character.jpg',
        reference_video: 'https://example.com/performance.mp4',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-charperf-001');
      expect(data.model).toBe('act_two');
    });
  });
});
