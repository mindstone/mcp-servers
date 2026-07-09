import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsHandlers } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, makeFakeAudioBuffer } from './fixtures/elevenlabs-data.js';

const BASE_V1 = 'https://api.elevenlabs.io/v1';

describe('Stage 3 multipart file-input tools', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;
  let outsideDir: string;
  const createdFiles: string[] = [];

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-s3-ws-')));
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-s3-out-')));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    createdFiles.length = 0;
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeWorkspaceClip(name = 'clip.mp3'): string {
    const p = path.join(workspaceDir, name);
    fs.writeFileSync(p, makeFakeAudioBuffer(512));
    createdFiles.push(p);
    return p;
  }

  async function openClient() {
    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });
  }

  describe('speech_to_speech', () => {
    it('converts audio and returns a tmp file path', async () => {
      mswServer.use(...createElevenLabsHandlers());
      await openClient();
      const clip = writeWorkspaceClip();

      const result = await testClient.callTool('speech_to_speech', {
        audio_path: clip,
        voice_id: 'voice-rachel-001',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.file_path).toBeTruthy();
      expect(parsed.size_bytes).toBeGreaterThan(0);
      expect(fs.existsSync(parsed.file_path)).toBe(true);
      createdFiles.push(parsed.file_path);
    });

    it('rejects paths outside the workspace sandbox', async () => {
      mswServer.use(...createElevenLabsHandlers());
      await openClient();
      const outside = path.join(outsideDir, 'outside.mp3');
      fs.writeFileSync(outside, makeFakeAudioBuffer(256));

      const result = await testClient.callTool('speech_to_speech', {
        audio_path: outside,
        voice_id: 'voice-rachel-001',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.code).toBe('PATH_SANDBOX_VIOLATION');
    });

    it('returns AUTH_REQUIRED without an API key', async () => {
      testClient = await createTestClient({
        env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
      });
      const result = await testClient.callTool('speech_to_speech', {
        audio_path: '/tmp/x.mp3',
        voice_id: 'voice-rachel-001',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('AUTH_REQUIRED');
    });
  });

  describe('isolate_audio', () => {
    it('isolates audio and returns a tmp file path', async () => {
      mswServer.use(...createElevenLabsHandlers());
      await openClient();
      const clip = writeWorkspaceClip();

      const result = await testClient.callTool('isolate_audio', { audio_path: clip });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(fs.existsSync(parsed.file_path)).toBe(true);
      createdFiles.push(parsed.file_path);
    });

    it('rejects paths outside the workspace sandbox', async () => {
      mswServer.use(...createElevenLabsHandlers());
      await openClient();
      const outside = path.join(outsideDir, 'outside.mp3');
      fs.writeFileSync(outside, makeFakeAudioBuffer(256));

      const result = await testClient.callTool('isolate_audio', { audio_path: outside });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.text).code).toBe('PATH_SANDBOX_VIOLATION');
    });
  });

  describe('forced_alignment', () => {
    it('returns enveloped aligned word text', async () => {
      mswServer.use(...createElevenLabsHandlers());
      await openClient();
      const clip = writeWorkspaceClip();

      const result = await testClient.callTool('forced_alignment', {
        file_path: clip,
        text: 'Hi.',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.words[0].text).toBe(
        '<untrusted-content source="elevenlabs:forced_alignment:word_text">Hi.</untrusted-content>',
      );
      expect(parsed.loss).toBe(0.01);
    });

    it('rejects paths outside the workspace sandbox', async () => {
      mswServer.use(...createElevenLabsHandlers());
      await openClient();
      const outside = path.join(outsideDir, 'outside.mp3');
      fs.writeFileSync(outside, makeFakeAudioBuffer(256));

      const result = await testClient.callTool('forced_alignment', {
        file_path: outside,
        text: 'Hi.',
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.text).code).toBe('PATH_SANDBOX_VIOLATION');
    });
  });

  describe('clone_voice', () => {
    it('creates a voice clone from sandboxed files', async () => {
      mswServer.use(...createElevenLabsHandlers());
      await openClient();
      const clip = writeWorkspaceClip();

      const result = await testClient.callTool('clone_voice', {
        name: 'test-clone',
        files: [clip],
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.voice_id).toBe('cloned-voice-001');
    });

    it('sandbox-checks every element of files[] individually', async () => {
      mswServer.use(...createElevenLabsHandlers());
      await openClient();
      const inWs = writeWorkspaceClip('good.mp3');
      const outside = path.join(outsideDir, 'bad.mp3');
      fs.writeFileSync(outside, makeFakeAudioBuffer(256));

      const result = await testClient.callTool('clone_voice', {
        name: 'mixed-clone',
        files: [inWs, outside],
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.text).code).toBe('PATH_SANDBOX_VIOLATION');
    });
  });

  describe('delete_voice', () => {
    it('deletes a voice successfully', async () => {
      mswServer.use(...createElevenLabsHandlers());
      await openClient();

      const result = await testClient.callTool('delete_voice', {
        voice_id: 'cloned-voice-001',
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.voice_id).toBe('cloned-voice-001');
    });

    it('maps HTTP 404 to VOICE_NOT_FOUND', async () => {
      mswServer.use(...createElevenLabsHandlers());
      await openClient();

      const result = await testClient.callTool('delete_voice', {
        voice_id: 'missing-voice-id',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.text);
      expect(parsed.code).toBe('VOICE_NOT_FOUND');
    });

    it('returns AUTH_FAILED on invalid credentials', async () => {
      const { createElevenLabsUnauthorizedHandlers } = await import('./helpers/elevenlabs-mock-server.js');
      mswServer.use(...createElevenLabsUnauthorizedHandlers());
      await openClient();

      const result = await testClient.callTool('delete_voice', {
        voice_id: 'cloned-voice-001',
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.text).code).toBe('AUTH_FAILED');
    });
  });

  describe('multipart field names', () => {
    it('speech_to_speech sends audio field (not file)', async () => {
      const captured: { hasAudio: boolean; hasFile: boolean } = { hasAudio: false, hasFile: false };
      mswServer.use(
        http.post(`${BASE_V1}/speech-to-speech/:voiceId`, async ({ request }) => {
          const form = await request.formData();
          captured.hasAudio = form.has('audio');
          captured.hasFile = form.has('file');
          return new HttpResponse(makeFakeAudioBuffer(512), {
            headers: { 'Content-Type': 'audio/mpeg' },
          });
        }),
      );
      await openClient();
      const clip = writeWorkspaceClip();
      await testClient.callTool('speech_to_speech', {
        audio_path: clip,
        voice_id: 'voice-rachel-001',
      });
      expect(captured.hasAudio).toBe(true);
      expect(captured.hasFile).toBe(false);
    });

    it('forced_alignment sends file + text fields', async () => {
      const captured: { hasFile: boolean; text?: string } = { hasFile: false };
      mswServer.use(
        http.post(`${BASE_V1}/forced-alignment`, async ({ request }) => {
          const form = await request.formData();
          captured.hasFile = form.has('file');
          const t = form.get('text');
          captured.text = typeof t === 'string' ? t : undefined;
          return HttpResponse.json({ words: [{ text: 'Hi.', start: 0, end: 0.3 }], loss: 0 });
        }),
      );
      await openClient();
      const clip = writeWorkspaceClip();
      await testClient.callTool('forced_alignment', {
        file_path: clip,
        text: 'Hi.',
      });
      expect(captured.hasFile).toBe(true);
      expect(captured.text).toBe('Hi.');
    });
  });
});
