import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
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
        voice: 'b0a4c1d2-0000-4000-8000-a1b2c3d4e5f6',
        model: 'eleven_v3',
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(false);
      expect(data.code).toBe('INVALID_INPUT');
      expect(data.error).toContain('preset voices only');
    });

    it('submits a custom voice UUID with eleven_multilingual_v2', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const customVoiceId = 'b0a4c1d2-0000-4000-8000-a1b2c3d4e5f6';
      const result = await testClient.callTool('generate_speech', {
        text: 'Hello from a custom voice.',
        voice: customVoiceId,
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.voice).toBe(customVoiceId);

      const postBody = capturedBodies.find(c => c.url.includes('/text_to_speech'))?.body as Record<string, unknown>;
      expect(postBody.voice).toEqual({ type: 'custom', id: customVoiceId });
    });

    it('rejects an unknown preset-like voice string with no upstream request', async () => {
      let requestCount = 0;
      mswServer.use(
        http.all('https://api.dev.runwayml.com/*', () => {
          requestCount++;
          return HttpResponse.json({});
        }),
      );

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Hello world.',
        voice: 'not-a-real-preset',
      });

      expect(result.isError).toBe(true);
      expect(requestCount).toBe(0);
    });

    it('rejects a malformed custom voice identifier with no upstream request', async () => {
      // UUID-shaped but not a valid UUID — the old `includes('-') && length > 20`
      // heuristic would have classified this as a custom voice and sent it
      // upstream.
      let requestCount = 0;
      mswServer.use(
        http.all('https://api.dev.runwayml.com/*', () => {
          requestCount++;
          return HttpResponse.json({});
        }),
      );

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Hello from a custom voice.',
        voice: 'b0a4c1d2-0000-4000-8000-customvoice01',
      });

      expect(result.isError).toBe(true);
      expect(requestCount).toBe(0);
    });

    it('rejects text over 1000 characters on the default model with no upstream request', async () => {
      let requestCount = 0;
      mswServer.use(
        http.all('https://api.dev.runwayml.com/*', () => {
          requestCount++;
          return HttpResponse.json({});
        }),
      );

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'a'.repeat(1001),
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(false);
      expect(data.code).toBe('INVALID_INPUT');
      expect(requestCount).toBe(0);
    });

    it('accepts text over 1000 characters when model is eleven_v3', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'a'.repeat(1500),
        model: 'eleven_v3',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);

      const postBody = capturedBodies.find(c => c.url.includes('/text_to_speech'))?.body as Record<string, unknown>;
      expect(postBody.promptText).toBe('a'.repeat(1500));
    });

    it('rejects text over 5000 characters with eleven_v3 with no upstream request', async () => {
      let requestCount = 0;
      mswServer.use(
        http.all('https://api.dev.runwayml.com/*', () => {
          requestCount++;
          return HttpResponse.json({});
        }),
      );

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'a'.repeat(5001),
        model: 'eleven_v3',
      });

      expect(result.isError).toBe(true);
      expect(requestCount).toBe(0);
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

    it('rejects prompt_text over 3000 characters with no upstream request', async () => {
      let requestCount = 0;
      mswServer.use(
        http.all('https://api.dev.runwayml.com/*', () => {
          requestCount++;
          return HttpResponse.json({});
        }),
      );

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_sound_effect', {
        prompt_text: 'a'.repeat(3001),
      });

      expect(result.isError).toBe(true);
      expect(requestCount).toBe(0);
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
