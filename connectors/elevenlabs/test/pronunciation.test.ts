import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsHandlers,
  createElevenLabsUnauthorizedHandlers,
} from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

describe('Pronunciation dictionary tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('list_pronunciation_dictionaries', () => {
    it('lists dictionaries with enveloped name and description (FREE)', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_pronunciation_dictionaries', {});
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.dictionaries).toHaveLength(1);
      const dict = parsed.dictionaries[0];
      expect(dict.id).toBe('pd-001');
      expect(dict.name).toBe(
        '<untrusted-content source="elevenlabs:list_pronunciation_dictionaries:name">Brand terms</untrusted-content>',
      );
      expect(dict.description).toBe(
        '<untrusted-content source="elevenlabs:list_pronunciation_dictionaries:description">How to say our product names</untrusted-content>',
      );
      expect(dict.archived).toBe(false);
      expect(parsed.cost).toContain('FREE');
    });

    it('returns AUTH_REQUIRED without an API key', async () => {
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('list_pronunciation_dictionaries', {});
      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_REQUIRED');
    });
  });

  describe('get_pronunciation_dictionary', () => {
    it('returns dictionary metadata with enveloped rules (FREE)', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('get_pronunciation_dictionary', {
        pronunciation_dictionary_id: 'pd-001',
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.id).toBe('pd-001');
      expect(parsed.rules).toHaveLength(1);
      expect(parsed.rules[0].string_to_replace).toBe(
        '<untrusted-content source="elevenlabs:get_pronunciation_dictionary:rule_string">Thailand</untrusted-content>',
      );
      expect(parsed.rules[0].alias).toBe(
        '<untrusted-content source="elevenlabs:get_pronunciation_dictionary:rule_alias">tie-land</untrusted-content>',
      );
    });

    it('returns DICTIONARY_NOT_FOUND for a missing dictionary', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('get_pronunciation_dictionary', {
        pronunciation_dictionary_id: 'missing-pd-id',
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.code).toBe('DICTIONARY_NOT_FOUND');
    });
  });

  describe('add_pronunciation_dictionary', () => {
    it('creates a dictionary from alias rules', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('add_pronunciation_dictionary', {
        name: 'Brand terms',
        rules: [{ string_to_replace: 'Thailand', type: 'alias', alias: 'tie-land' }],
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.id).toBe('pd-002');
      expect(parsed.version_id).toBe('pd-002-v1');
      expect(parsed.version_rules_num).toBe(1);
    });

    it('rejects an empty rules array at the schema boundary', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('add_pronunciation_dictionary', {
        name: 'Brand terms',
        rules: [],
      });
      expect(result.isError).toBe(true);
    });

    it('returns AUTH_FAILED on invalid credentials', async () => {
      mswServer.use(...createElevenLabsUnauthorizedHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: 'bad-key', MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('add_pronunciation_dictionary', {
        name: 'Brand terms',
        rules: [{ string_to_replace: 'Thailand', type: 'alias', alias: 'tie-land' }],
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.code).toBe('AUTH_FAILED');
    });
  });

  describe('archive_pronunciation_dictionary', () => {
    it('archives a dictionary', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('archive_pronunciation_dictionary', {
        pronunciation_dictionary_id: 'pd-001',
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.pronunciation_dictionary_id).toBe('pd-001');
    });

    it('returns DICTIONARY_NOT_FOUND for a missing dictionary', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('archive_pronunciation_dictionary', {
        pronunciation_dictionary_id: 'missing-pd-id',
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.code).toBe('DICTIONARY_NOT_FOUND');
    });
  });
});
