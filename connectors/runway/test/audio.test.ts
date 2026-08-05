import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createRunwayHandlers, createBodyCapturingHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

describe('Audio generation tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('generate_speech', () => {
    it('submits with voice preset', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Hello world, this is a test of speech generation.',
        voice: 'Bernard',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-tts-001');
      expect(data.voice).toBe('Bernard');
      expect(data.estimated_credits).toBeGreaterThan(0);
    });

    it('submits eleven_v3 with a preset voice', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Wow [laughs], that is amazing!',
        voice: 'Maya',
        model: 'eleven_v3',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.model).toBe('eleven_v3');

      const postBody = capturedBodies.find(c => c.url.includes('/text_to_speech'))?.body as Record<string, unknown>;
      expect(postBody.model).toBe('eleven_v3');
      expect(postBody.promptText).toBe('Wow [laughs], that is amazing!');
      expect(postBody.voice).toEqual({ type: 'runway-preset', presetId: 'Maya' });
    });

    it('rejects a custom voice with eleven_v3', async () => {
      mswServer.use(...createRunwayHandlers());

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Hello from a custom voice.',
        voice: 'b0a4c1d2-0000-4000-8000-customvoice01',
        model: 'eleven_v3',
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(false);
      expect(data.code).toBe('INVALID_INPUT');
      expect(data.error).toContain('preset voices only');
    });

    it('defaults to eleven_multilingual_v2 when model is omitted', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      await testClient.callTool('generate_speech', { text: 'Default model check.' });

      const postBody = capturedBodies.find(c => c.url.includes('/text_to_speech'))?.body as Record<string, unknown>;
      expect(postBody.model).toBe('eleven_multilingual_v2');
    });
  });

  describe('generate_sound_effect', () => {
    it('submits with duration and loop', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_sound_effect', {
        prompt_text: 'Heavy rain on a tin roof',
        duration: 10,
        loop: true,
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-sfx-001');

      const postBody = capturedBodies.find(c => c.url.includes('/sound_effect'))?.body as Record<string, unknown>;
      expect(postBody.duration).toBe(10);
      expect(postBody.loop).toBe(true);
    });
  });

  describe('swap_voice', () => {
    it('submits with voice preset and audio URI', async () => {
      mswServer.use(...createRunwayHandlers());

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('swap_voice', {
        media: 'https://example.com/audio.mp3',
        voice: 'Bernard',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-sts-001');
      expect(data.voice).toBe('Bernard');
    });
  });

  describe('dub_audio', () => {
    it('submits with audio and target language', async () => {
      mswServer.use(...createRunwayHandlers());

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('dub_audio', {
        audio: 'https://example.com/speech.mp3',
        target_language: 'es',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-dub-001');
      expect(data.target_language).toBe('es');
    });
  });

  describe('isolate_voice', () => {
    it('submits with audio URI', async () => {
      mswServer.use(...createRunwayHandlers());

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('isolate_voice', {
        audio: 'https://example.com/noisy-audio.mp3',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe('task-iso-001');
    });
  });
});
