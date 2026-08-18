import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsHandlers,
  createEmptyVoiceSearchHandlers,
  createStthCapturingHandler,
} from './helpers/elevenlabs-mock-server.js';
import { http, HttpResponse } from 'msw';
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
      // API-resolved voice names arrive wrapped per AGENTS.md invariant #6.
      expect(parsed.voice).toBe(
        '<untrusted-content source="elevenlabs:generate_speech:voice_name">Rachel</untrusted-content>',
      );
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

    it('defaults to the first premade voice on the account when no voice specified', async () => {
      // Regression for 0.3.0: previously hardcoded "Rachel" lookup, which
      // silently failed on accounts that don't have Rachel. Now we fetch
      // the account's voices and pick the first premade one.
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
      // mockVoices[0] is Rachel (premade) so this still picks her, but the
      // logic now generalises to any premade voice on the account.
      expect(parsed.voice).toBe(
        '<untrusted-content source="elevenlabs:generate_speech:voice_name">Rachel</untrusted-content>',
      );

      // Cleanup
      if (fs.existsSync(parsed.file_path)) {
        fs.unlinkSync(parsed.file_path);
      }
    });

    it('signposts the arbitrary default voice when none is specified', async () => {
      // The default pick is language-blind by design (no language input
      // exists to filter against), so the result must say so — the agent can
      // then retry with an explicit voice when the language matters instead
      // of shipping uncontrolled audio invisibly.
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
      expect(parsed.voice_note).toContain('arbitrary account default');
      expect(parsed.voice_note).toContain('voice_id');

      if (fs.existsSync(parsed.file_path)) {
        fs.unlinkSync(parsed.file_path);
      }
    });

    it('adds no voice_note when an explicit voice_id is given', async () => {
      mswServer.use(...createElevenLabsHandlers());
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const result = await testClient.callTool('generate_speech', {
        text: 'Explicit voice test.',
        voice_id: 'voice-adam-002',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.voice_id).toBe('voice-adam-002');
      expect(parsed.voice_note).toBeUndefined();

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

  describe('generate_speech — default voice fallback edge cases', () => {
    function premadeVoice(voice_id: string, name: string) {
      return { voice_id, name, category: 'premade' as const, description: '', labels: {}, preview_url: '' };
    }
    function clonedVoice(voice_id: string, name: string) {
      return { voice_id, name, category: 'cloned' as const, description: '', labels: {}, preview_url: '' };
    }
    function generatedVoice(voice_id: string, name: string) {
      return { voice_id, name, category: 'generated' as const, description: '', labels: {}, preview_url: '' };
    }

    function customVoiceHandlers(voices: ReturnType<typeof premadeVoice>[]) {
      return [
        http.get('https://api.elevenlabs.io/v2/voices', () =>
          HttpResponse.json({ voices, has_more: false }),
        ),
        http.post('https://api.elevenlabs.io/v1/text-to-speech/:voiceId', () =>
          new HttpResponse(makeFakeAudioBuffer(2048), {
            headers: { 'Content-Type': 'audio/mpeg' },
          }),
        ),
      ];
    }

    it('falls back to the first premade voice when account has both premade and cloned', async () => {
      mswServer.use(...customVoiceHandlers([
        clonedVoice('v-cloned-1', 'Cloned A'),
        premadeVoice('v-premade-1', 'Premade A'),
      ]));
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('generate_speech', { text: 'hi' });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.voice).toBe(
        '<untrusted-content source="elevenlabs:generate_speech:voice_name">Premade A</untrusted-content>',
      );
      if (fs.existsSync(parsed.file_path)) fs.unlinkSync(parsed.file_path);
    });

    it('falls back to the first cloned voice when account has only cloned voices', async () => {
      mswServer.use(...customVoiceHandlers([
        clonedVoice('v-cloned-only', 'Cloned Only'),
      ]));
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('generate_speech', { text: 'hi' });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.voice).toBe(
        '<untrusted-content source="elevenlabs:generate_speech:voice_name">Cloned Only</untrusted-content>',
      );
      if (fs.existsSync(parsed.file_path)) fs.unlinkSync(parsed.file_path);
    });

    it('falls back to the first generated voice when account has only generated voices', async () => {
      mswServer.use(...customVoiceHandlers([
        generatedVoice('v-gen-only', 'Generated Only'),
      ]));
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('generate_speech', { text: 'hi' });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.voice).toBe(
        '<untrusted-content source="elevenlabs:generate_speech:voice_name">Generated Only</untrusted-content>',
      );
      if (fs.existsSync(parsed.file_path)) fs.unlinkSync(parsed.file_path);
    });
  });

  describe('transcribe_audio', () => {
    it('sends multipart field `file` plus model_id=scribe_v1 and tag_audio_events=false (NOT `audio`)', async () => {
      const { handler, captured } = createStthCapturingHandler(MOCK_API_KEY);
      mswServer.use(handler);
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
      });

      const tmpFile = path.join(os.tmpdir(), `elevenlabs-shape-${Date.now()}.mp3`);
      fs.writeFileSync(tmpFile, makeFakeAudioBuffer(128));
      try {
        const result = await testClient.callTool('transcribe_audio', { file_path: tmpFile });
        expect(result.isError).toBeFalsy();
        expect(captured.hasFile).toBe(true);
        expect(captured.hasAudio).toBe(false);
        expect(captured.fileMimeType).toBe('audio/mpeg');
        expect(captured.modelId).toBe('scribe_v1');
        expect(captured.tagAudioEvents).toBe('false');
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

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
        // Transcript text arrives wrapped per AGENTS.md invariant #6.
        expect(parsed.text).toBe(
          '<untrusted-content source="elevenlabs:transcribe_audio:text">Hello, this is a test transcription.</untrusted-content>',
        );
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
