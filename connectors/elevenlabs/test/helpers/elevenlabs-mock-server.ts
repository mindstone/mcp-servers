import { http, HttpResponse } from 'msw';
import {
  MOCK_API_KEY,
  mockVoices,
  mockMusicPlan,
  mockTranscription,
  mockSubscription,
  mockModels,
  mockSharedVoices,
  mockVoiceDetail,
  mockForcedAlignment,
  mockCloneVoice,
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
  ];
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
  } = { fieldNames: [], hasFile: false, hasAudio: false };

  const handler = http.post(`${BASE_V1}/speech-to-text`, async ({ request }) => {
    const authError = checkAuth(request, expectedApiKey);
    if (authError) return authError;
    const form = await request.formData();
    for (const [k] of form) captured.fieldNames.push(k);
    captured.hasFile = form.has('file');
    captured.hasAudio = form.has('audio');
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
