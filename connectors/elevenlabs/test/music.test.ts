import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsHandlers } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, mockMusicPlan } from './fixtures/elevenlabs-data.js';

describe('Music tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('generate_music', () => {
    it('generates music and returns file path with non-zero size', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_music', {
        prompt: 'A relaxing lo-fi hip hop beat',
        duration_seconds: 10,
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.file_path).toBeTruthy();
      expect(parsed.size_bytes).toBeGreaterThan(0);
      expect(parsed.format).toBe('mp3_44100_128');

      // Verify file actually exists
      expect(fs.existsSync(parsed.file_path)).toBe(true);

      // Cleanup
      fs.unlinkSync(parsed.file_path);
    });

    it('rejects empty prompt via Zod before outbound request', async () => {
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_music', {
        prompt: '',
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('create_music_plan', () => {
    it('creates a plan with sections (FREE)', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('create_music_plan', {
        prompt: 'A 60-second cinematic score',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.composition_plan).toBeDefined();
      expect(parsed.composition_plan.sections).toHaveLength(2);
      expect(parsed.num_sections).toBe(2);
      expect(parsed.cost).toContain('FREE');
    });
  });

  describe('generate_music_from_plan', () => {
    it('generates music from a composition plan', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_music_from_plan', {
        composition_plan: mockMusicPlan,
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.file_path).toBeTruthy();
      expect(parsed.size_bytes).toBeGreaterThan(0);

      // Cleanup
      if (fs.existsSync(parsed.file_path)) {
        fs.unlinkSync(parsed.file_path);
      }
    });

    it('round-trips a plan returned by create_music_plan verbatim', async () => {
      // Regression test for the conversation that triggered 0.3.0:
      // create_music_plan returns the canonical ElevenLabs shape; the
      // generate_music_from_plan Zod schema must accept it without renaming
      // or stripping any fields.
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const planResult = await testClient.callTool('create_music_plan', {
        prompt: 'A 30-second pop chorus',
      });
      expect(planResult.isError).toBeFalsy();
      const planParsed = JSON.parse(planResult.text);

      const generateResult = await testClient.callTool('generate_music_from_plan', {
        composition_plan: planParsed.composition_plan,
      });
      expect(generateResult.isError).toBeFalsy();
      const generateParsed = JSON.parse(generateResult.text);
      expect(generateParsed.ok).toBe(true);
      expect(generateParsed.file_path).toBeTruthy();
      if (fs.existsSync(generateParsed.file_path)) {
        fs.unlinkSync(generateParsed.file_path);
      }
    });

    it('rejects plan with empty sections via Zod', async () => {
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_music_from_plan', {
        composition_plan: {
          positive_global_styles: ['jazz'],
          negative_global_styles: [],
          sections: [],
        },
      });

      expect(result.isError).toBe(true);
    });

    it('rejects legacy {style, lyrics} section shape via Zod', async () => {
      // The legacy shape from ≤0.2.2 is now strictly rejected before the
      // request goes out — schema requires section_name + duration_ms.
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_music_from_plan', {
        composition_plan: {
          positive_global_styles: ['jazz'],
          sections: [
            { style: 'soft piano', lyrics: 'la la la', duration_ms: 5000 },
          ],
        },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('generate_music — force_instrumental + lyric markers warning', () => {
    it('emits a warning when force_instrumental: true is set with [Verse]/[Chorus] markers', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_music', {
        prompt: '[Verse]\nCity lights tonight\n[Chorus]\nWe shine on',
        duration_seconds: 10,
        force_instrumental: true,
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.warnings).toBeDefined();
      expect(parsed.warnings[0]).toContain('force_instrumental');
      if (fs.existsSync(parsed.file_path)) {
        fs.unlinkSync(parsed.file_path);
      }
    });

    it('does not warn when force_instrumental: true is set without lyric markers', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_music', {
        prompt: 'A relaxing lo-fi instrumental beat',
        duration_seconds: 10,
        force_instrumental: true,
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.warnings).toBeUndefined();
      if (fs.existsSync(parsed.file_path)) {
        fs.unlinkSync(parsed.file_path);
      }
    });
  });
});
