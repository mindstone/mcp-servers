import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createRunwayHandlers, createBodyCapturingHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

describe('Custom voice tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('list_custom_voices', () => {
    it('returns voice list', async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_custom_voices', {});

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.count).toBe(1);
      expect(data.voices[0].id).toBe('voice-001');
      expect(data.voices[0].name).toBe('Corporate Narrator');
      expect(data.voices[0].status).toBe('READY');
    });
  });

  describe('create_custom_voice', () => {
    it('submits with correct params', async () => {
      const { handlers, capturedBodies } = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...handlers);

      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('create_custom_voice', {
        name: 'Friendly Host',
        prompt: 'A warm, friendly female voice with enthusiasm and energy',
        model: 'eleven_ttv_v3',
        description: 'For podcast intros',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.voice_id).toBe('voice-new-002');

      const postBody = capturedBodies.find(c => c.url.includes('/voices') && !c.url.includes('/preview'))?.body as Record<string, unknown>;
      expect(postBody.name).toBe('Friendly Host');
      expect((postBody.from as Record<string, unknown>).model).toBe('eleven_ttv_v3');
    });
  });

  describe('preview_voice', () => {
    it('returns preview URL', async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('preview_voice', {
        prompt: 'A deep authoritative male voice with a calm demeanor',
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.preview_url).toContain('preview.mp3');
      expect(data.duration_seconds).toBe(5);
    });
  });

  describe('delete_custom_voice', () => {
    it('deletes successfully', async () => {
      mswServer.use(...createRunwayHandlers());
      testClient = await createTestClient({
        env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('delete_custom_voice', { voice_id: 'voice-001' });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.ok).toBe(true);
      expect(data.message).toContain('deleted');
    });
  });
});
