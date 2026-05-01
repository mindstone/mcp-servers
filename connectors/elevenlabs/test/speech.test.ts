import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsHandlers, createEmptyVoiceSearchHandlers } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, makeFakeAudioBuffer } from './fixtures/elevenlabs-data.js';

describe('Speech tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  describe('generate_speech', () => {
    it('generates speech with voice lookup by name', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Hello, this is a test.',
        voice_name: 'Rachel',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.file_path).toBeTruthy();
      expect(parsed.size_bytes).toBeGreaterThan(0);
      expect(parsed.voice).toBe('Rachel');
      expect(parsed.voice_id).toBe('voice-rachel-001');

      // Cleanup
      if (fs.existsSync(parsed.file_path)) {
        fs.unlinkSync(parsed.file_path);
      }
    });

    it('generates speech with direct voice_id', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Direct voice ID test.',
        voice_id: 'voice-adam-002',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.voice_id).toBe('voice-adam-002');

      // Cleanup
      if (fs.existsSync(parsed.file_path)) {
        fs.unlinkSync(parsed.file_path);
      }
    });

    it('defaults to Rachel when no voice specified', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Default voice test.',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.voice).toBe('Rachel');

      // Cleanup
      if (fs.existsSync(parsed.file_path)) {
        fs.unlinkSync(parsed.file_path);
      }
    });

    it('returns isError:true when default voice lookup fails', async () => {
      mswServer.use(...createEmptyVoiceSearchHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Test without voice.',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('VOICE_NOT_FOUND');
    });

    it('returns isError:true when explicit voice_name lookup fails', async () => {
      mswServer.use(...createEmptyVoiceSearchHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Test with bad voice name.',
        voice_name: 'NonExistentVoice',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('VOICE_NOT_FOUND');
    });
  });

  describe('generate_sound_effect', () => {
    it('generates a sound effect and returns file path', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_sound_effect', {
        prompt: 'Thunder rolling in the distance',
        duration_seconds: 5,
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
  });

  describe('transcribe_audio', () => {
    it('transcribes an audio file and returns text', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      // Create a temporary audio file for transcription
      const tmpFile = path.join(os.tmpdir(), `elevenlabs-test-${Date.now()}.mp3`);
      fs.writeFileSync(tmpFile, makeFakeAudioBuffer(512));

      try {
        const result = await testClient.callTool('transcribe_audio', {
          file_path: tmpFile,
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(result.text);
        expect(parsed.ok).toBe(true);
        expect(parsed.text).toBe('Hello, this is a test transcription.');
        expect(parsed.word_count).toBe(6);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('returns isError:true for non-existent file', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      // Use an in-workspace (os.tmpdir() default) missing-file path so
      // the M3.9 sandbox does NOT trigger before the FILE_NOT_FOUND
      // branch — this test is the no-such-file regression, not the
      // out-of-sandbox regression (those live in
      // test/transcription-security.test.ts).
      const missingInTmp = path.join(
        fs.realpathSync(os.tmpdir()),
        `nonexistent-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`,
      );

      const result = await testClient.callTool('transcribe_audio', {
        file_path: missingInTmp,
      });

      // Must return isError: true via withErrorHandling
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('File not found');
      expect(parsed.code).toBe('FILE_NOT_FOUND');
    });
  });
});
