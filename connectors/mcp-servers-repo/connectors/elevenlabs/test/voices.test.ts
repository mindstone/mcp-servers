import { describe, it, expect, afterEach, vi } from 'vitest';
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
      expect(parsed.voices[0].name).toBe('Rachel');
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
      expect(parsed.voices[0].name).toBe('Adam');
    });
  });
});
