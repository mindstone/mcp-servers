import { http, HttpResponse } from 'msw';
import {
  MOCK_API_KEY,
  mockVoices,
  mockMusicPlan,
  mockTranscription,
  mockDiarizedTranscription,
  mockHistory,
  mockWorkspaceUsage,
  mockPronunciationDictionaryList,
  mockPronunciationDictionaryDetail,
  mockAddPronunciationDictionary,
  mockSpeechWithTimestamps,
  mockSubscription,
  mockModels,
  mockSharedVoices,
  mockVoiceDetail,
  mockForcedAlignment,
  mockCloneVoice,
  mockVoiceDesignPreviews,
  mockCreateVoiceFromPreview,
  mockDubbingCreate,
  mockDubbingStatusProcessing,
  mockDubbingStatusDubbed,
  mockDubbingStatusFailed,
  makeFakeAudioBuffer,
} from '../fixtures/elevenlabs-data.js';

const BASE_V1 = 'https://api.elevenlabs.io/v1';
const BASE_V2 = 'https://api.elevenlabs.io/v2';

/**
 * Verify xi-api-key header. Returns a 401 HttpResponse on failure, null on success.
 */
function checkAuth(request: Request, expectedKey = MOCK_API_KEY) {
  const key = request.headers.get('xi-api-key');
  if (key !== expectedKey) {
    return HttpResponse.json(
      { detail: { message: 'Invalid API key' } },
      { status: 401 },
    );
  }
  return null;
}

/**
 * Creates MSW handlers for the ElevenLabs API.
 * Verifies xi-api-key header on every request.
 */
export function createElevenLabsHandlers(expectedApiKey = MOCK_API_KEY) {
  return [
    // POST /music — generate music (returns binary audio)
    http.post(`${BASE_V1}/music`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const audioBuffer = makeFakeAudioBuffer(2048);
      return new HttpResponse(audioBuffer, {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),

    // POST /music/plan — create music plan (returns JSON)
    http.post(`${BASE_V1}/music/plan`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockMusicPlan);
    }),

    // POST /text-to-speech/:voiceId — TTS (returns binary audio)
    http.post(`${BASE_V1}/text-to-speech/:voiceId`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const audioBuffer = makeFakeAudioBuffer(4096);
      return new HttpResponse(audioBuffer, {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),

    // POST /sound-generation — sound effects (returns binary audio)
    http.post(`${BASE_V1}/sound-generation`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const audioBuffer = makeFakeAudioBuffer(1024);
      return new HttpResponse(audioBuffer, {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),

    // GET /v1/user/subscription
    http.get(`${BASE_V1}/user/subscription`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockSubscription);
    }),

    // GET /v1/models
    http.get(`${BASE_V1}/models`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockModels);
    }),

    // GET /v1/voices/:voiceId
    http.get(`${BASE_V1}/voices/:voiceId`, ({ request, params }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const voiceId = params.voiceId as string;
      const voice = mockVoices.find((v) => v.voice_id === voiceId) ?? mockVoiceDetail;
      if (voiceId === 'missing-voice-id') {
        return HttpResponse.json({ detail: 'Voice not found' }, { status: 404 });
      }
      return HttpResponse.json(voice);
    }),

    // GET /v1/shared-voices
    http.get(`${BASE_V1}/shared-voices`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;

      const url = new URL(request.url);
      const search = url.searchParams.get('search');
      let voices = mockSharedVoices;
      if (search) {
        voices = mockSharedVoices.filter((v) =>
          v.name.toLowerCase().includes(search.toLowerCase()) ||
          (v.description ?? '').toLowerCase().includes(search.toLowerCase()),
        );
      }

      return HttpResponse.json({
        voices,
        has_more: false,
      });
    }),

    // GET /v2/voices — list/search voices (returns JSON)
    http.get(`${BASE_V2}/voices`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;

      const url = new URL(request.url);
      const search = url.searchParams.get('search');

      let voices = mockVoices;
      if (search) {
        voices = mockVoices.filter((v) =>
          v.name.toLowerCase().includes(search.toLowerCase()),
        );
      }

      return HttpResponse.json({
        voices,
        has_more: false,
      });
    }),

    // POST /speech-to-text — transcription (returns JSON)
    http.post(`${BASE_V1}/speech-to-text`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockTranscription);
    }),

    // POST /speech-to-speech/:voiceId — voice conversion (binary audio)
    http.post(`${BASE_V1}/speech-to-speech/:voiceId`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const audioBuffer = makeFakeAudioBuffer(2048);
      return new HttpResponse(audioBuffer, {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),

    // POST /audio-isolation — noise removal (binary audio)
    http.post(`${BASE_V1}/audio-isolation`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const audioBuffer = makeFakeAudioBuffer(1536);
      return new HttpResponse(audioBuffer, {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),

    // POST /forced-alignment — align transcript to audio (JSON)
    http.post(`${BASE_V1}/forced-alignment`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockForcedAlignment);
    }),

    // POST /voices/add — instant voice clone (JSON)
    http.post(`${BASE_V1}/voices/add`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockCloneVoice);
    }),

    // DELETE /voices/:voiceId
    http.delete(`${BASE_V1}/voices/:voiceId`, ({ request, params }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      if (params.voiceId === 'missing-voice-id') {
        return HttpResponse.json({ detail: 'Voice not found' }, { status: 404 });
      }
      return new HttpResponse(null, { status: 200 });
    }),

    // POST /text-to-dialogue — multi-voice dialogue (binary audio)
    http.post(`${BASE_V1}/text-to-dialogue`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const audioBuffer = makeFakeAudioBuffer(3072);
      return new HttpResponse(audioBuffer, {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),

    // POST /text-to-voice/design — voice design previews (JSON)
    http.post(`${BASE_V1}/text-to-voice/design`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockVoiceDesignPreviews);
    }),

    // POST /text-to-voice — create voice from preview (JSON)
    http.post(`${BASE_V1}/text-to-voice`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockCreateVoiceFromPreview);
    }),

    // POST /dubbing — submit dubbing job (JSON)
    http.post(`${BASE_V1}/dubbing`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockDubbingCreate);
    }),

    // GET /dubbing/:id — dubbing status (JSON; default dubbed)
    http.get(`${BASE_V1}/dubbing/:dubbingId`, ({ request, params }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const dubbingId = params.dubbingId as string;
      if (dubbingId === 'missing-dub-id') {
        return HttpResponse.json({ detail: 'Dubbing not found' }, { status: 404 });
      }
      if (dubbingId === 'dub-failed-001') {
        return HttpResponse.json(mockDubbingStatusFailed);
      }
      return HttpResponse.json(mockDubbingStatusDubbed);
    }),

    // GET /dubbing/:id/audio/:lang — dubbed audio download (binary)
    http.get(`${BASE_V1}/dubbing/:dubbingId/audio/:lang`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const audioBuffer = makeFakeAudioBuffer(2048);
      return new HttpResponse(audioBuffer, {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),

    // DELETE /dubbing/:id
    http.delete(`${BASE_V1}/dubbing/:dubbingId`, ({ request, params }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      if (params.dubbingId === 'missing-dub-id') {
        return HttpResponse.json({ detail: 'Dubbing not found' }, { status: 404 });
      }
      return new HttpResponse(null, { status: 200 });
    }),

    // GET /history — list generated items (JSON)
    http.get(`${BASE_V1}/history`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockHistory);
    }),

    // GET /history/:id/audio — history audio download (binary)
    http.get(`${BASE_V1}/history/:historyItemId/audio`, ({ request, params }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      if (params.historyItemId === 'missing-history-id') {
        return HttpResponse.json({ detail: 'History item not found' }, { status: 404 });
      }
      const audioBuffer = makeFakeAudioBuffer(2048);
      return new HttpResponse(audioBuffer, {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),

    // POST /workspace/analytics/query/usage-by-product-over-time (JSON)
    http.post(`${BASE_V1}/workspace/analytics/query/usage-by-product-over-time`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockWorkspaceUsage);
    }),

    // GET /pronunciation-dictionaries — list (JSON)
    http.get(`${BASE_V1}/pronunciation-dictionaries`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockPronunciationDictionaryList);
    }),

    // POST /pronunciation-dictionaries/add-from-rules (JSON)
    http.post(`${BASE_V1}/pronunciation-dictionaries/add-from-rules`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockAddPronunciationDictionary);
    }),

    // GET /pronunciation-dictionaries/:id — metadata + rules (JSON)
    http.get(`${BASE_V1}/pronunciation-dictionaries/:dictionaryId`, ({ request, params }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      if (params.dictionaryId === 'missing-pd-id') {
        return HttpResponse.json({ detail: 'Pronunciation dictionary not found' }, { status: 404 });
      }
      return HttpResponse.json(mockPronunciationDictionaryDetail);
    }),

    // PATCH /pronunciation-dictionaries/:id — archive (JSON)
    http.patch(`${BASE_V1}/pronunciation-dictionaries/:dictionaryId`, ({ request, params }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      if (params.dictionaryId === 'missing-pd-id') {
        return HttpResponse.json({ detail: 'Pronunciation dictionary not found' }, { status: 404 });
      }
      return HttpResponse.json({
        ...mockPronunciationDictionaryDetail,
        archived_time_unix: 1_754_831_999,
      });
    }),

    // POST /text-to-speech/:voiceId/with-timestamps (JSON: base64 + alignment)
    http.post(`${BASE_V1}/text-to-speech/:voiceId/with-timestamps`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockSpeechWithTimestamps);
    }),
  ];
}

/**
 * Create-voice-from-preview handler that captures the JSON body sent by
 * `create_voice_from_preview`. Used to assert required voice_description forwarding.
 */
export function createVoiceFromPreviewCapturingHandler(expectedApiKey = MOCK_API_KEY) {
  const captured: {
    body?: Record<string, unknown>;
  } = {};

  const handler = http.post(`${BASE_V1}/text-to-voice`, async ({ request }) => {
    const authError = checkAuth(request, expectedApiKey);
    if (authError) return authError;
    captured.body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(mockCreateVoiceFromPreview);
  });
  return { handler, captured };
}

/**
 * Voice-design handler that captures the JSON body sent by `design_voice`.
 * Used to assert auto_generate_text / text omission behavior.
 */
export function createVoiceDesignCapturingHandler(expectedApiKey = MOCK_API_KEY) {
  const captured: {
    body?: Record<string, unknown>;
  } = {};

  const handler = http.post(`${BASE_V1}/text-to-voice/design`, async ({ request }) => {
    const authError = checkAuth(request, expectedApiKey);
    if (authError) return authError;
    captured.body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(mockVoiceDesignPreviews);
  });
  return { handler, captured };
}

/**
 * STT handler that captures the multipart form-data fields sent by
 * `transcribe_audio`. Used to assert that we send `file`+`model_id` (not
 * the legacy `audio` field name).
 */
export function createStthCapturingHandler(expectedApiKey = MOCK_API_KEY) {
  const captured: {
    fieldNames: string[];
    modelId?: string;
    tagAudioEvents?: string;
    languageCode?: string;
    hasFile: boolean;
    hasAudio: boolean;
    fileMimeType?: string;
  } = { fieldNames: [], hasFile: false, hasAudio: false };

  const handler = http.post(`${BASE_V1}/speech-to-text`, async ({ request }) => {
    const authError = checkAuth(request, expectedApiKey);
    if (authError) return authError;
    const form = await request.formData();
    for (const [k] of form) captured.fieldNames.push(k);
    captured.hasFile = form.has('file');
    captured.hasAudio = form.has('audio');
    const filePart = form.get('file');
    if (filePart instanceof Blob) captured.fileMimeType = filePart.type;
    const m = form.get('model_id');
    if (typeof m === 'string') captured.modelId = m;
    const t = form.get('tag_audio_events');
    if (typeof t === 'string') captured.tagAudioEvents = t;
    const l = form.get('language_code');
    if (typeof l === 'string') captured.languageCode = l;
    return HttpResponse.json(mockTranscription);
  });
  return { handler, captured };
}

/**
 * STT handler that captures diarization/timestamp form fields sent by
 * `transcribe_audio` and returns a diarized transcript fixture.
 */
export function createDiarizedSttCapturingHandler(expectedApiKey = MOCK_API_KEY) {
  const captured: {
    diarize?: string;
    numSpeakers?: string;
    diarizationThreshold?: string;
    timestampsGranularity?: string;
  } = {};

  const handler = http.post(`${BASE_V1}/speech-to-text`, async ({ request }) => {
    const authError = checkAuth(request, expectedApiKey);
    if (authError) return authError;
    const form = await request.formData();
    const d = form.get('diarize');
    if (typeof d === 'string') captured.diarize = d;
    const n = form.get('num_speakers');
    if (typeof n === 'string') captured.numSpeakers = n;
    const t = form.get('diarization_threshold');
    if (typeof t === 'string') captured.diarizationThreshold = t;
    const g = form.get('timestamps_granularity');
    if (typeof g === 'string') captured.timestampsGranularity = g;
    return HttpResponse.json(mockDiarizedTranscription);
  });
  return { handler, captured };
}

/**
 * Dubbing handler that captures the multipart file MIME type sent by
 * `create_dubbing`. Used to assert typed Blob uploads (not octet-stream).
 */
export function createDubbingCapturingHandler(expectedApiKey = MOCK_API_KEY) {
  const captured: {
    fileMimeType?: string;
    targetLang?: string;
  } = {};

  const handler = http.post(`${BASE_V1}/dubbing`, async ({ request }) => {
    const authError = checkAuth(request, expectedApiKey);
    if (authError) return authError;
    const form = await request.formData();
    const filePart = form.get('file');
    if (filePart instanceof Blob) captured.fileMimeType = filePart.type;
    const lang = form.get('target_lang');
    if (typeof lang === 'string') captured.targetLang = lang;
    return HttpResponse.json(mockDubbingCreate);
  });
  return { handler, captured };
}

/**
 * Creates handlers that return 401 for all ElevenLabs API requests.
 */
export function createElevenLabsUnauthorizedHandlers() {
  return [
    http.get(`${BASE_V1}/*`, () =>
      HttpResponse.json({ detail: { message: 'Invalid API key' } }, { status: 401 }),
    ),
    http.post(`${BASE_V1}/*`, () =>
      HttpResponse.json({ detail: { message: 'Invalid API key' } }, { status: 401 }),
    ),
    http.delete(`${BASE_V1}/*`, () =>
      HttpResponse.json({ detail: { message: 'Invalid API key' } }, { status: 401 }),
    ),
    http.get(`${BASE_V2}/*`, () =>
      HttpResponse.json({ detail: { message: 'Invalid API key' } }, { status: 401 }),
    ),
    http.post(`${BASE_V2}/*`, () =>
      HttpResponse.json({ detail: { message: 'Invalid API key' } }, { status: 401 }),
    ),
  ];
}

/**
 * Stateful dubbing status handler for status-transition tests.
 * First GET returns processing; subsequent GETs return dubbed.
 */
export function createDubbingStatusTransitionHandlers(expectedApiKey = MOCK_API_KEY) {
  const pollCounts = new Map<string, number>();

  return [
    http.get(`${BASE_V1}/dubbing/:dubbingId`, ({ request, params }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const dubbingId = params.dubbingId as string;
      if (dubbingId !== 'dub-transition-001') {
        return HttpResponse.json(mockDubbingStatusDubbed);
      }
      const count = (pollCounts.get(dubbingId) ?? 0) + 1;
      pollCounts.set(dubbingId, count);
      if (count < 2) {
        return HttpResponse.json({
          ...mockDubbingStatusProcessing,
          dubbing_id: dubbingId,
        });
      }
      return HttpResponse.json({
        ...mockDubbingStatusDubbed,
        dubbing_id: dubbingId,
      });
    }),
  ];
}

/**
 * Creates handlers that time out for all ElevenLabs API requests.
 */
export function createElevenLabsTimeoutHandlers() {
  return [
    http.get(`${BASE_V1}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
    http.post(`${BASE_V1}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
    http.get(`${BASE_V2}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
    http.post(`${BASE_V2}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
  ];
}

/**
 * Creates bridge mock handlers for ElevenLabs configure flow.
 */
export function createElevenLabsBridgeHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/elevenlabs/configure`, async ({ request }) => {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${token}`) {
        return HttpResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401 },
        );
      }
      return HttpResponse.json({ success: true });
    }),
  ];
}

/**
 * Creates bridge handlers that return 401.
 */
export function createElevenLabsBridge401Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/elevenlabs/configure`, () => {
      return HttpResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 },
      );
    }),
  ];
}

/**
 * Creates bridge handlers that return 403.
 */
export function createElevenLabsBridge403Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/elevenlabs/configure`, () => {
      return HttpResponse.json(
        { success: false, error: 'Forbidden' },
        { status: 403 },
      );
    }),
  ];
}

/**
 * Creates bridge handlers that return { success: false }.
 */
export function createElevenLabsBridgeFailureHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/elevenlabs/configure`, async ({ request }) => {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${token}`) {
        return HttpResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401 },
        );
      }
      return HttpResponse.json({ success: false, error: 'Account validation failed' });
    }),
  ];
}

/**
 * Creates handlers where voice search always returns empty results.
 * Used to test default voice lookup failure in generate_speech.
 */
export function createEmptyVoiceSearchHandlers(expectedApiKey = MOCK_API_KEY) {
  return [
    http.get(`${BASE_V2}/voices`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ voices: [], has_more: false });
    }),
    // Still provide TTS endpoint in case voice lookup somehow passes
    http.post(`${BASE_V1}/text-to-speech/:voiceId`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const audioBuffer = makeFakeAudioBuffer(4096);
      return new HttpResponse(audioBuffer, {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }),
  ];
}

/**
 * Creates handlers that track xi-api-key header on requests.
 * Returns captured requests for assertion.
 */
export function createAuthCapturingHandlers(expectedApiKey = MOCK_API_KEY) {
  const capturedHeaders: Array<{ url: string; xiApiKey: string | null }> = [];

  const handlers = [
    http.post(`${BASE_V1}/music/plan`, async ({ request }) => {
      capturedHeaders.push({
        url: request.url,
        xiApiKey: request.headers.get('xi-api-key'),
      });
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockMusicPlan);
    }),
    http.get(`${BASE_V2}/voices`, ({ request }) => {
      capturedHeaders.push({
        url: request.url,
        xiApiKey: request.headers.get('xi-api-key'),
      });
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ voices: mockVoices, has_more: false });
    }),
  ];

  return { handlers, capturedHeaders };
}
