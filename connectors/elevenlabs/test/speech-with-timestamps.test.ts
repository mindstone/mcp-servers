import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { mswServer } from './helpers/setup.js';
import { createElevenLabsHandlers } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

describe('generate_speech_with_timestamps', () => {
  let testClient: McpTestClient;
  const createdFiles: string[] = [];

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    createdFiles.length = 0;
  });

  it('writes audio, alignment JSON, and an SRT subtitle file', async () => {
    mswServer.use(...createElevenLabsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('generate_speech_with_timestamps', {
      text: 'Welcome home.',
      voice_id: 'voice-rachel-001',
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.voice_id).toBe('voice-rachel-001');
    expect(parsed.word_count).toBe(2);
    expect(parsed.cue_count).toBe(1);
    expect(parsed.duration_seconds).toBeCloseTo(1.4);

    for (const key of ['file_path', 'srt_path', 'alignment_path'] as const) {
      expect(parsed[key], key).toBeTruthy();
      expect(fs.existsSync(parsed[key]), key).toBe(true);
      createdFiles.push(parsed[key]);
    }

    const srt = fs.readFileSync(parsed.srt_path, 'utf8');
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,400');
    expect(srt).toContain('Welcome home.');

    const alignment = JSON.parse(fs.readFileSync(parsed.alignment_path, 'utf8'));
    expect(alignment.characters).toHaveLength(13);
  });

  it('envelopes an API-resolved voice name', async () => {
    mswServer.use(...createElevenLabsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('generate_speech_with_timestamps', {
      text: 'Welcome home.',
      voice_name: 'Rachel',
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.voice).toBe(
      '<untrusted-content source="elevenlabs:generate_speech_with_timestamps:voice_name">Rachel</untrusted-content>',
    );
    createdFiles.push(parsed.file_path, parsed.srt_path, parsed.alignment_path);
  });

  it('returns AUTH_REQUIRED without an API key', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('generate_speech_with_timestamps', {
      text: 'Hello.',
      voice_id: 'voice-rachel-001',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('AUTH_REQUIRED');
  });
});
