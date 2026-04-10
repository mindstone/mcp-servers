import { http, HttpResponse } from 'msw';
import {
  MOCK_API_KEY,
  mockOrgResponse,
  mockUsageResponse,
  mockTaskSucceeded,
  mockTaskFailed,
  mockVoiceList,
  mockVoicePreview,
} from '../fixtures/runway-data.js';

const BASE = 'https://api.dev.runwayml.com/v1';

/**
 * Verify Authorization: Bearer header + X-Runway-Version header.
 * Returns a 401 HttpResponse on failure, null on success.
 */
function checkAuth(request: Request, expectedKey = MOCK_API_KEY) {
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${expectedKey}`) {
    return HttpResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }
  const version = request.headers.get('X-Runway-Version');
  if (!version) {
    return HttpResponse.json({ error: 'Missing X-Runway-Version header' }, { status: 400 });
  }
  return null;
}

/**
 * Creates MSW handlers for the Runway API.
 * Verifies Bearer auth + X-Runway-Version header on every request.
 */
export function createRunwayHandlers(expectedApiKey = MOCK_API_KEY) {
  return [
    // GET /v1/organization — balance/credits
    http.get(`${BASE}/organization`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockOrgResponse);
    }),

    // POST /v1/organization/usage — credit usage analytics
    http.post(`${BASE}/organization/usage`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockUsageResponse);
    }),

    // GET /v1/tasks/:id — check task status
    http.get(`${BASE}/tasks/:taskId`, ({ request, params }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const taskId = params.taskId as string;
      if (taskId === 'task-abc-123') return HttpResponse.json(mockTaskSucceeded);
      if (taskId === 'task-fail-456') return HttpResponse.json(mockTaskFailed);
      return HttpResponse.json({ error: 'Task not found' }, { status: 404 });
    }),

    // DELETE /v1/tasks/:id — cancel task
    http.delete(`${BASE}/tasks/:taskId`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return new HttpResponse(null, { status: 204 });
    }),

    // POST /v1/text_to_video
    http.post(`${BASE}/text_to_video`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'task-text2vid-001' });
    }),

    // POST /v1/image_to_video
    http.post(`${BASE}/image_to_video`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'task-img2vid-001' });
    }),

    // POST /v1/video_to_video
    http.post(`${BASE}/video_to_video`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'task-vid2vid-001' });
    }),

    // POST /v1/character_performance
    http.post(`${BASE}/character_performance`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'task-charperf-001' });
    }),

    // POST /v1/text_to_image
    http.post(`${BASE}/text_to_image`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'task-img-001' });
    }),

    // POST /v1/text_to_speech
    http.post(`${BASE}/text_to_speech`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'task-tts-001' });
    }),

    // POST /v1/sound_effect
    http.post(`${BASE}/sound_effect`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'task-sfx-001' });
    }),

    // POST /v1/speech_to_speech
    http.post(`${BASE}/speech_to_speech`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'task-sts-001' });
    }),

    // POST /v1/voice_dubbing
    http.post(`${BASE}/voice_dubbing`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'task-dub-001' });
    }),

    // POST /v1/voice_isolation
    http.post(`${BASE}/voice_isolation`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'task-iso-001' });
    }),

    // GET /v1/voices — list custom voices
    http.get(`${BASE}/voices`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockVoiceList);
    }),

    // POST /v1/voices — create custom voice
    http.post(`${BASE}/voices`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'voice-new-002' });
    }),

    // POST /v1/voices/preview — preview voice
    http.post(`${BASE}/voices/preview`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockVoicePreview);
    }),

    // DELETE /v1/voices/:id — delete voice
    http.delete(`${BASE}/voices/:voiceId`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return new HttpResponse(null, { status: 204 });
    }),

    // POST /v1/uploads — ephemeral upload
    http.post(`${BASE}/uploads`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({
        uploadUrl: 'https://runway-uploads.example.com/upload',
        fields: { key: 'mcp-test-runway-upload-key', 'Content-Type': 'application/octet-stream' },
        runwayUri: 'runway://test-upload-001',
      });
    }),
  ];
}

/**
 * Creates handlers that return 401 for all Runway API requests.
 */
export function createRunwayUnauthorizedHandlers() {
  return [
    http.get(`${BASE}/*`, () =>
      HttpResponse.json({ error: 'Invalid API key' }, { status: 401 }),
    ),
    http.post(`${BASE}/*`, () =>
      HttpResponse.json({ error: 'Invalid API key' }, { status: 401 }),
    ),
    http.delete(`${BASE}/*`, () =>
      HttpResponse.json({ error: 'Invalid API key' }, { status: 401 }),
    ),
  ];
}

/**
 * Creates handlers that time out for all Runway API requests.
 */
export function createRunwayTimeoutHandlers() {
  return [
    http.get(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
    http.post(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
    http.delete(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
  ];
}

/**
 * Creates bridge mock handlers for Runway configure flow.
 */
export function createRunwayBridgeHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/runway/configure`, async ({ request }) => {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${token}`) {
        return HttpResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }
      return HttpResponse.json({ success: true });
    }),
  ];
}

/**
 * Creates bridge handlers that return 401.
 */
export function createRunwayBridge401Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/runway/configure`, () => {
      return HttpResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }),
  ];
}

/**
 * Creates bridge handlers that return 403.
 */
export function createRunwayBridge403Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/runway/configure`, () => {
      return HttpResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }),
  ];
}

/**
 * Creates bridge handlers that return { success: false }.
 */
export function createRunwayBridgeFailureHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/runway/configure`, async ({ request }) => {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${token}`) {
        return HttpResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }
      return HttpResponse.json({ success: false, error: 'Account validation failed' });
    }),
  ];
}

/**
 * Creates handlers that track Authorization + X-Runway-Version headers.
 */
export function createAuthCapturingHandlers(expectedApiKey = MOCK_API_KEY) {
  const capturedHeaders: Array<{
    url: string;
    authorization: string | null;
    xRunwayVersion: string | null;
  }> = [];

  const handlers = [
    http.get(`${BASE}/organization`, ({ request }) => {
      capturedHeaders.push({
        url: request.url,
        authorization: request.headers.get('Authorization'),
        xRunwayVersion: request.headers.get('X-Runway-Version'),
      });
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockOrgResponse);
    }),
    http.post(`${BASE}/text_to_video`, async ({ request }) => {
      capturedHeaders.push({
        url: request.url,
        authorization: request.headers.get('Authorization'),
        xRunwayVersion: request.headers.get('X-Runway-Version'),
      });
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ id: 'task-text2vid-001' });
    }),
  ];

  return { handlers, capturedHeaders };
}

/**
 * Creates handlers that capture request bodies for assertions.
 */
export function createBodyCapturingHandlers(expectedApiKey = MOCK_API_KEY) {
  const capturedBodies: Array<{
    url: string;
    method: string;
    body: unknown;
  }> = [];

  const handlers = [
    http.post(`${BASE}/text_to_video`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json({ id: 'task-text2vid-001' });
    }),
    http.post(`${BASE}/image_to_video`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json({ id: 'task-img2vid-001' });
    }),
    http.post(`${BASE}/text_to_image`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json({ id: 'task-img-001' });
    }),
    http.post(`${BASE}/text_to_speech`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json({ id: 'task-tts-001' });
    }),
    http.post(`${BASE}/sound_effect`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json({ id: 'task-sfx-001' });
    }),
    http.post(`${BASE}/speech_to_speech`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json({ id: 'task-sts-001' });
    }),
    http.post(`${BASE}/voice_dubbing`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json({ id: 'task-dub-001' });
    }),
    http.post(`${BASE}/voice_isolation`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json({ id: 'task-iso-001' });
    }),
    http.post(`${BASE}/character_performance`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json({ id: 'task-charperf-001' });
    }),
    http.post(`${BASE}/video_to_video`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json({ id: 'task-vid2vid-001' });
    }),
    http.post(`${BASE}/voices`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json({ id: 'voice-new-002' });
    }),
    http.post(`${BASE}/voices/preview`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const body = await request.json();
      capturedBodies.push({ url: request.url, method: 'POST', body });
      return HttpResponse.json(mockVoicePreview);
    }),
    http.get(`${BASE}/organization`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockOrgResponse);
    }),
    http.post(`${BASE}/organization/usage`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(mockUsageResponse);
    }),
  ];

  return { handlers, capturedBodies };
}
