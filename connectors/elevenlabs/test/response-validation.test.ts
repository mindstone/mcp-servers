/**
 * Fail-closed Zod validation of external API responses: a malformed or
 * drifted payload must surface as a structured INVALID_RESPONSE error, never
 * reach tool logic as an unchecked cast.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, makeFakeAudioBuffer } from './fixtures/elevenlabs-data.js';

const BASE_V1 = 'https://api.elevenlabs.io/v1';

describe('external response validation (fail-closed)', () => {
  let testClient: McpTestClient;
  let workspaceDir: string;
  let clipPath: string;

  beforeEach(() => {
    workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-resp-ws-')));
    clipPath = path.join(workspaceDir, 'clip.mp3');
    fs.writeFileSync(clipPath, makeFakeAudioBuffer(256));
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

  async function expectInvalidResponse(tool: string, args: Record<string, unknown>) {
    const result = await testClient.callTool(tool, args);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('INVALID_RESPONSE');
  }

  it('list_pronunciation_dictionaries rejects a malformed list payload', async () => {
    mswServer.use(
      http.get(`${BASE_V1}/pronunciation-dictionaries`, () =>
        HttpResponse.json({ pronunciation_dictionaries: [{ id: 'pd-1' /* name missing */ }] }),
      ),
    );
    await openClient();
    await expectInvalidResponse('list_pronunciation_dictionaries', {});
  });

  it('get_pronunciation_dictionary rejects a rule of an unknown type', async () => {
    mswServer.use(
      http.get(`${BASE_V1}/pronunciation-dictionaries/:dictionaryId`, () =>
        HttpResponse.json({
          id: 'pd-1',
          name: 'D',
          rules: [{ string_to_replace: 'x', type: 'regex' }],
        }),
      ),
    );
    await openClient();
    await expectInvalidResponse('get_pronunciation_dictionary', {
      pronunciation_dictionary_id: 'pd-1',
    });
  });

  it('add_pronunciation_dictionary rejects a creation payload without an id', async () => {
    mswServer.use(
      http.post(`${BASE_V1}/pronunciation-dictionaries/add-from-rules`, () =>
        HttpResponse.json({ name: 'D', version_rules_num: 1 }),
      ),
    );
    await openClient();
    await expectInvalidResponse('add_pronunciation_dictionary', {
      name: 'D',
      rules: [{ string_to_replace: 'Thailand', type: 'alias', alias: 'tie-land' }],
    });
  });

  it('transcribe_audio rejects malformed word timing values', async () => {
    mswServer.use(
      http.post(`${BASE_V1}/speech-to-text`, () =>
        HttpResponse.json({
          text: 'Hello',
          words: [{ text: 'Hello', start: 'zero', end: 0.4, type: 'word' }],
        }),
      ),
    );
    await openClient();
    await expectInvalidResponse('transcribe_audio', { file_path: clipPath });
  });

  it('transcribe_audio rejects a non-string speaker identifier', async () => {
    mswServer.use(
      http.post(`${BASE_V1}/speech-to-text`, () =>
        HttpResponse.json({
          text: 'Hello',
          words: [{ text: 'Hello', start: 0, end: 0.4, type: 'word', speaker_id: 7 }],
        }),
      ),
    );
    await openClient();
    await expectInvalidResponse('transcribe_audio', { file_path: clipPath, diarize: true });
  });

  it('transcribe_audio rejects a non-string transcript', async () => {
    mswServer.use(
      http.post(`${BASE_V1}/speech-to-text`, () =>
        HttpResponse.json({ text: 42, words: [] }),
      ),
    );
    await openClient();
    await expectInvalidResponse('transcribe_audio', { file_path: clipPath });
  });

  it('list_history rejects a non-array history field', async () => {
    mswServer.use(
      http.get(`${BASE_V1}/history`, () =>
        HttpResponse.json({ history: 'not-an-array', has_more: false }),
      ),
    );
    await openClient();
    await expectInvalidResponse('list_history', {});
  });

  it('list_history rejects an item without history_item_id', async () => {
    mswServer.use(
      http.get(`${BASE_V1}/history`, () =>
        HttpResponse.json({ history: [{ voice_name: 'no id' }], has_more: false }),
      ),
    );
    await openClient();
    await expectInvalidResponse('list_history', {});
  });

  it('generate_speech_with_timestamps rejects invalid base64 audio', async () => {
    mswServer.use(
      http.post(`${BASE_V1}/text-to-speech/:voiceId/with-timestamps`, () =>
        HttpResponse.json({ audio_base64: 'not valid base64!!!', alignment: null }),
      ),
    );
    await openClient();
    await expectInvalidResponse('generate_speech_with_timestamps', {
      text: 'Hello.',
      voice_id: 'voice-rachel-001',
    });
  });

  it('generate_speech_with_timestamps rejects mismatched alignment array lengths', async () => {
    mswServer.use(
      http.post(`${BASE_V1}/text-to-speech/:voiceId/with-timestamps`, () =>
        HttpResponse.json({
          audio_base64: Buffer.from(makeFakeAudioBuffer(64)).toString('base64'),
          alignment: {
            characters: ['a', 'b'],
            character_start_times_seconds: [0, 0.1],
            character_end_times_seconds: [0.1],
          },
        }),
      ),
    );
    await openClient();
    await expectInvalidResponse('generate_speech_with_timestamps', {
      text: 'Hello.',
      voice_id: 'voice-rachel-001',
    });
  });

  it('generate_speech_with_timestamps rejects negative alignment timestamps', async () => {
    mswServer.use(
      http.post(`${BASE_V1}/text-to-speech/:voiceId/with-timestamps`, () =>
        HttpResponse.json({
          audio_base64: Buffer.from(makeFakeAudioBuffer(64)).toString('base64'),
          alignment: {
            characters: ['a'],
            character_start_times_seconds: [-0.5],
            character_end_times_seconds: [0.1],
          },
        }),
      ),
    );
    await openClient();
    await expectInvalidResponse('generate_speech_with_timestamps', {
      text: 'Hello.',
      voice_id: 'voice-rachel-001',
    });
  });

  it('generate_speech_with_timestamps rejects non-monotonic alignment start times', async () => {
    mswServer.use(
      http.post(`${BASE_V1}/text-to-speech/:voiceId/with-timestamps`, () =>
        HttpResponse.json({
          audio_base64: Buffer.from(makeFakeAudioBuffer(64)).toString('base64'),
          normalized_alignment: {
            characters: ['a', 'b'],
            character_start_times_seconds: [0.5, 0.1],
            character_end_times_seconds: [0.6, 0.2],
          },
        }),
      ),
    );
    await openClient();
    await expectInvalidResponse('generate_speech_with_timestamps', {
      text: 'Hello.',
      voice_id: 'voice-rachel-001',
    });
    // Parse fails before any artifact write: only the clip fixture exists.
    expect(fs.readdirSync(workspaceDir)).toEqual(['clip.mp3']);
  });

  it('the INVALID_RESPONSE error does not echo raw upstream values', async () => {
    mswServer.use(
      http.post(`${BASE_V1}/speech-to-text`, () =>
        HttpResponse.json({ text: 'secret-upstream-marker-do-not-echo', words: 'oops' }),
      ),
    );
    await openClient();
    const result = await testClient.callTool('transcribe_audio', { file_path: clipPath });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text).code).toBe('INVALID_RESPONSE');
    expect(result.text).not.toContain('secret-upstream-marker-do-not-echo');
  });
});
