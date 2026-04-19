import { http, HttpResponse } from 'msw';
import {
  MOCK_API_KEY,
  createMockGeminiResponse,
} from '../fixtures/nano-banana-data.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Verify Gemini API key from query param. Returns a 401 HttpResponse on failure, null on success.
 */
function checkAuth(request: Request, expectedKey = MOCK_API_KEY) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (key !== expectedKey) {
    return HttpResponse.json(
      { error: { message: 'API key not valid. Please pass a valid API key.' } },
      { status: 401 },
    );
  }
  return null;
}

/**
 * Creates MSW handlers for the Gemini API.
 * Verifies query-param API key on every request.
 */
export function createNanoBananaHandlers(expectedApiKey = MOCK_API_KEY) {
  return [
    // POST /models/{model}:generateContent — Gemini generateContent
    http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(createMockGeminiResponse());
    }),
  ];
}

/**
 * Creates handlers that return 401 for all Gemini API requests.
 */
export function createNanoBananaUnauthorizedHandlers() {
  return [
    http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, () =>
      HttpResponse.json(
        { error: { message: 'API key not valid. Please pass a valid API key.' } },
        { status: 401 },
      ),
    ),
  ];
}

/**
 * Creates handlers that return 429 (rate limited) for all Gemini API requests.
 */
export function createNanoBananaRateLimitedHandlers() {
  return [
    http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, () =>
      HttpResponse.json(
        { error: { message: 'Rate limit exceeded' } },
        { status: 429 },
      ),
    ),
  ];
}

/**
 * Creates handlers that time out for all Gemini API requests.
 */
export function createNanoBananaTimeoutHandlers() {
  return [
    http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 120_000));
      return HttpResponse.json({});
    }),
  ];
}

/**
 * Creates bridge mock handlers for NanoBanana configure flow.
 */
export function createNanoBananaBridgeHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/nanobanana/configure`, async ({ request }) => {
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
export function createNanoBananaBridge401Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/nanobanana/configure`, () => {
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
export function createNanoBananaBridge403Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/nanobanana/configure`, () => {
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
export function createNanoBananaBridgeFailureHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/nanobanana/configure`, async ({ request }) => {
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
 * Creates handlers that track query-param API key on requests.
 * Returns captured requests for assertion.
 */
export function createAuthCapturingHandlers(expectedApiKey = MOCK_API_KEY) {
  const capturedRequests: Array<{ url: string; queryKey: string | null; hasAuthHeader: boolean }> = [];

  const handlers = [
    http.post(`${GEMINI_API_BASE}/models/:model\\:generateContent`, async ({ request }) => {
      const url = new URL(request.url);
      capturedRequests.push({
        url: request.url,
        queryKey: url.searchParams.get('key'),
        hasAuthHeader: request.headers.has('Authorization'),
      });
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(createMockGeminiResponse());
    }),
  ];

  return { handlers, capturedRequests };
}
