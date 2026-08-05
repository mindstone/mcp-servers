import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mswServer } from './helpers/setup.js';
import { createDiarizedSttCapturingHandler } from './helpers/elevenlabs-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, makeFakeAudioBuffer } from './fixtures/elevenlabs-data.js';

describe('transcribe_audio — diarization and timestamps', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;
  let clipPath: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-diar-ws-')));
    clipPath = path.join(workspaceDir, 'meeting.mp3');
    fs.writeFileSync(clipPath, makeFakeAudioBuffer(512));
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function openClient() {
    testClient = await createTestClient({
      env: {
        ELEVENLABS_API_KEY: MOCK_API_KEY,
        MCP_HOST_BRIDGE_STATE: '',
        MCP_WORKSPACE_PATH: workspaceDir,
      },
    });
  }

  it('forwards diarization form fields and groups words into enveloped utterances', async () => {
    const { handler, captured } = createDiarizedSttCapturingHandler();
    mswServer.use(handler);
    await openClient();

    const result = await testClient.callTool('transcribe_audio', {
      file_path: clipPath,
      diarize: true,
      num_speakers: 2,
      timestamps_granularity: 'word',
    });

    expect(result.isError).toBeFalsy();
    expect(captured.diarize).toBe('true');
    expect(captured.numSpeakers).toBe('2');
    expect(captured.timestampsGranularity).toBe('word');

    const parsed = JSON.parse(result.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.speaker_count).toBe(2);
    expect(parsed.utterances).toHaveLength(2);
    expect(parsed.utterances[0].speaker_id).toBe('speaker_0');
    expect(parsed.utterances[0].start_seconds).toBe(0);
    expect(parsed.utterances[0].end_seconds).toBe(0.8);
    expect(parsed.utterances[0].text).toBe(
      '<untrusted-content source="elevenlabs:transcribe_audio:utterance_text">Hello there.</untrusted-content>',
    );
    expect(parsed.utterances[1].speaker_id).toBe('speaker_1');
    expect(parsed.utterances[1].text).toBe(
      '<untrusted-content source="elevenlabs:transcribe_audio:utterance_text">Hi, how are you?</untrusted-content>',
    );
    // Word timestamps are opt-in only.
    expect(parsed.words).toBeUndefined();
  });

  it('includes enveloped word timestamps when requested', async () => {
    const { handler } = createDiarizedSttCapturingHandler();
    mswServer.use(handler);
    await openClient();

    const result = await testClient.callTool('transcribe_audio', {
      file_path: clipPath,
      include_word_timestamps: true,
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text);
    expect(parsed.words).toHaveLength(6);
    expect(parsed.words[0].text).toBe(
      '<untrusted-content source="elevenlabs:transcribe_audio:word_text">Hello</untrusted-content>',
    );
    expect(parsed.words[0].start_seconds).toBe(0);
    expect(parsed.words[0].speaker_id).toBe('speaker_0');
  });

  it('rejects num_speakers combined with diarization_threshold — with zero network requests', async () => {
    const { handler, captured } = createDiarizedSttCapturingHandler();
    mswServer.use(handler);
    await openClient();

    const result = await testClient.callTool('transcribe_audio', {
      file_path: clipPath,
      diarize: true,
      num_speakers: 2,
      diarization_threshold: 0.3,
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.text);
    expect(parsed.code).toBe('INVALID_INPUT');
    // The conflict is rejected before any upload leaves the process.
    expect(captured.requestCount).toBe(0);
  });

  it('rejects num_speakers when diarize is not enabled — with zero network requests', async () => {
    const { handler, captured } = createDiarizedSttCapturingHandler();
    mswServer.use(handler);
    await openClient();

    const result = await testClient.callTool('transcribe_audio', {
      file_path: clipPath,
      num_speakers: 2,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text).code).toBe('INVALID_INPUT');
    expect(captured.requestCount).toBe(0);
  });

  it('rejects diarization_threshold when diarize is false — with zero network requests', async () => {
    const { handler, captured } = createDiarizedSttCapturingHandler();
    mswServer.use(handler);
    await openClient();

    const result = await testClient.callTool('transcribe_audio', {
      file_path: clipPath,
      diarize: false,
      diarization_threshold: 0.3,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text).code).toBe('INVALID_INPUT');
    expect(captured.requestCount).toBe(0);
  });

  it('forwards diarization_threshold when diarize is true and num_speakers is omitted', async () => {
    const { handler, captured } = createDiarizedSttCapturingHandler();
    mswServer.use(handler);
    await openClient();

    const result = await testClient.callTool('transcribe_audio', {
      file_path: clipPath,
      diarize: true,
      diarization_threshold: 0.25,
    });

    expect(result.isError).toBeFalsy();
    expect(captured.requestCount).toBe(1);
    expect(captured.diarize).toBe('true');
    expect(captured.diarizationThreshold).toBe('0.25');
    expect(captured.numSpeakers).toBeUndefined();
  });

  it('returns AUTH_REQUIRED without an API key', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: '', MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('transcribe_audio', {
      file_path: clipPath,
      diarize: true,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('AUTH_REQUIRED');
  });
});
