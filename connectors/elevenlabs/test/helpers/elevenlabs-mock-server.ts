import { http, HttpResponse } from 'msw';
import {
  MOCK_API_KEY,
  mockVoices,
  mockMusicPlan,
  mockTranscription,
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
  ];
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
