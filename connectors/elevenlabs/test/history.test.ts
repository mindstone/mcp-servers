import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsHandlers,
  createElevenLabsUnauthorizedHandlers,
} from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

describe('History tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('list_history', () => {
    it('lists generated items with enveloped text and voice_name (FREE)', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_history', { page_size: 10 });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.items).toHaveLength(1);
      const item = parsed.items[0];
      expect(item.history_item_id).toBe('hist-item-001');
      expect(item.model_id).toBe('eleven_v3');
      expect(item.characters_used).toBe(42);
      expect(item.text).toBe(
        '<untrusted-content source="elevenlabs:list_history:text">Welcome to the launch.</untrusted-content>',
      );
      expect(item.voice_name).toBe(
        '<untrusted-content source="elevenlabs:list_history:voice_name">Rachel</untrusted-content>',
      );
      expect(parsed.has_more).toBe(false);
      expect(parsed.last_history_item_id).toBe('hist-item-001');
      expect(parsed.cost).toContain('FREE');
    });

    it('returns AUTH_REQUIRED without an API key', async () => {
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_history', {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_REQUIRED');
    });

    it('returns AUTH_FAILED on invalid credentials', async () => {
      mswServer.use(...createElevenLabsUnauthorizedHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: 'bad-key', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_history', {});
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.code).toBe('AUTH_FAILED');
    });
  });

  describe('get_history_item_audio', () => {
    it('downloads history audio to a tmp file (FREE)', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('get_history_item_audio', {
        history_item_id: 'hist-item-001',
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.file_path).toBeTruthy();
      expect(parsed.size_bytes).toBeGreaterThan(0);
      expect(fs.existsSync(parsed.file_path)).toBe(true);
      fs.unlinkSync(parsed.file_path);
    });

    it('returns HISTORY_ITEM_NOT_FOUND for a missing item', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('get_history_item_audio', {
        history_item_id: 'missing-history-id',
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.code).toBe('HISTORY_ITEM_NOT_FOUND');
    });

    it('returns AUTH_REQUIRED without an API key', async () => {
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('get_history_item_audio', {
        history_item_id: 'hist-item-001',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_REQUIRED');
    });
  });
});
