import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsHandlers,
  createElevenLabsUnauthorizedHandlers,
} from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

const BASE_V1 = 'https://api.elevenlabs.io/v1';

describe('Account tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('check_subscription', () => {
    it('returns subscription tier and character usage (FREE)', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('check_subscription', {});
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.tier).toBe(
        '<untrusted-content source="elevenlabs:check_subscription:tier">starter</untrusted-content>',
      );
      expect(parsed.character_count).toBe(12_500);
      expect(parsed.character_limit).toBe(30_000);
      expect(parsed.characters_remaining).toBe(17_500);
      expect(parsed.next_character_count_reset_unix).toBe(1_735_689_600);
      expect(parsed.next_character_count_reset_iso).toBe(
        new Date(1_735_689_600 * 1000).toISOString(),
      );
      expect(parsed.cost).toContain('FREE');
    });

    it('returns AUTH_REQUIRED without an API key', async () => {
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('check_subscription', {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_REQUIRED');
    });

    it('returns AUTH_FAILED on invalid credentials', async () => {
      mswServer.use(...createElevenLabsUnauthorizedHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: 'bad-key', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('check_subscription', {});
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.code).toBe('AUTH_FAILED');
    });
  });

  describe('list_models', () => {
    it('lists models with enveloped names (FREE)', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_models', {});
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.models).toHaveLength(2);
      expect(parsed.models[0].model_id).toBe('eleven_v3');
      expect(parsed.models[0].name).toBe(
        '<untrusted-content source="elevenlabs:list_models:name">Eleven v3</untrusted-content>',
      );
      expect(parsed.models[0].languages[0].language_id).toBe(
        '<untrusted-content source="elevenlabs:list_models:language_id">en</untrusted-content>',
      );
      expect(parsed.models[0].languages[0].name).toBe(
        '<untrusted-content source="elevenlabs:list_models:language_name">English</untrusted-content>',
      );
      expect(parsed.cost).toContain('FREE');
    });

    it('returns AUTH_FAILED on invalid credentials', async () => {
      mswServer.use(...createElevenLabsUnauthorizedHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: 'bad-key', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_models', {});
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.code).toBe('AUTH_FAILED');
    });
  });
});

describe('Voice tools — extended', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('get_voice', () => {
    it('returns voice detail with enveloped text fields (FREE)', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('get_voice', { voice_id: 'voice-rachel-001' });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.voice.voice_id).toBe('voice-rachel-001');
      expect(parsed.voice.name).toBe(
        '<untrusted-content source="elevenlabs:get_voice:name">Rachel</untrusted-content>',
      );
      expect(parsed.cost).toContain('FREE');
    });

    it('returns VOICE_NOT_FOUND for missing voice_id', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('get_voice', { voice_id: 'missing-voice-id' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.code).toBe('VOICE_NOT_FOUND');
      expect(parsed.resolution).toContain('search_shared_voices');
    });
  });

  describe('search_shared_voices', () => {
    it('returns shared voices with enveloped third-party text (FREE)', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('search_shared_voices', { page_size: 5 });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.voices).toHaveLength(1);
      expect(parsed.voices[0].name).toBe(
        '<untrusted-content source="elevenlabs:search_shared_voices:name">British Narrator</untrusted-content>',
      );
      expect(parsed.voices[0].accent).toBe(
        '<untrusted-content source="elevenlabs:search_shared_voices:accent">british</untrusted-content>',
      );
      expect(parsed.cost).toContain('FREE');
    });

    it('filters shared voices by search term', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('search_shared_voices', {
        search: 'British',
        page_size: 1,
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.voices).toHaveLength(1);
    });

    it('returns AUTH_FAILED on invalid credentials', async () => {
      mswServer.use(
        http.get(`${BASE_V1}/shared-voices`, () =>
          HttpResponse.json({ detail: { message: 'Invalid API key' } }, { status: 401 }),
        ),
      );
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: 'bad-key', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('search_shared_voices', {});
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.code).toBe('AUTH_FAILED');
    });
  });
});
