import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsHandlers } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

describe('Voice tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('list_voices', () => {
    it('lists available voices (FREE)', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_voices', {});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.voices).toHaveLength(2);
      expect(parsed.voices[0].voice_id).toBe('voice-rachel-001');
      // External-authored name arrives wrapped per AGENTS.md invariant #6.
      expect(parsed.voices[0].name).toBe(
        '<untrusted-content source="elevenlabs:list_voices:name">Rachel</untrusted-content>',
      );
      expect(parsed.cost).toContain('FREE');
    });

    it('filters voices by search query', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_voices', {
        search: 'Adam',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.voices).toHaveLength(1);
      expect(parsed.voices[0].name).toBe(
        '<untrusted-content source="elevenlabs:list_voices:name">Adam</untrusted-content>',
      );
    });
  });
  describe('credential-named reply fields', () => {
    const canary = 'canary-review-unissued-credential';
    const voice = { voice_id: 'voice_example', name: 'Example', labels: { webhook_secret: canary, accent: 'English' } };

    it('get_voice masks a credential-named label and keeps the others readable', async () => {
      mswServer.use(http.get('https://api.elevenlabs.io/v1/voices/:voiceId', () => HttpResponse.json(voice)));
      testClient = await createTestClient({ env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' } });

      const result = await testClient.callTool('get_voice', { voice_id: 'voice_example' });

      expect(result.isError).toBeFalsy();
      expect(result.text).not.toContain(canary);
      const parsed = JSON.parse(result.text);
      // Label keys and values are both enveloped as untrusted content.
      const labels = Object.values(parsed.voice.labels) as string[];
      expect(labels.some(value => value.includes('[REDACTED]'))).toBe(true);
      expect(labels.some(value => value.includes('English'))).toBe(true);
    });

    it('list_voices masks a credential-named label and keeps the others readable', async () => {
      mswServer.use(http.get('https://api.elevenlabs.io/v2/voices', () => HttpResponse.json({ voices: [voice], has_more: false })));
      testClient = await createTestClient({ env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' } });

      const result = await testClient.callTool('list_voices', {});

      expect(result.isError).toBeFalsy();
      expect(result.text).not.toContain(canary);
      const parsed = JSON.parse(result.text);
      // Label keys and values are both enveloped as untrusted content.
      const labels = Object.values(parsed.voices[0].labels) as string[];
      expect(labels.some(value => value.includes('[REDACTED]'))).toBe(true);
      expect(labels.some(value => value.includes('English'))).toBe(true);
    });
  });
});
