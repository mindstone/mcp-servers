import { http, HttpResponse } from 'msw';
import {
  MOCK_API_KEY,
  mockRequestId,
  makeCreateVisualResponse,
  makeCompletedStatus,
  mockSvgContent,
} from '../fixtures/napkin-data.js';

const BASE = 'https://api.napkin.ai/v1';

/**
 * Verify Authorization Bearer header. Returns a 401 HttpResponse on failure, null on success.
 */
function checkAuth(request: Request, expectedKey = MOCK_API_KEY) {
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${expectedKey}`) {
    return HttpResponse.json(
      { error: 'Invalid API key' },
      { status: 401 },
    );
  }
  return null;
}

/**
 * Creates MSW handlers for the Napkin API.
 * Verifies Bearer auth header on every request.
 */
export function createNapkinHandlers(expectedApiKey = MOCK_API_KEY) {
  return [
    // POST /visual — create visual
    http.post(`${BASE}/visual`, async ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(makeCreateVisualResponse());
    }),

    // GET /visual/:id/status — check status
    http.get(`${BASE}/visual/:id/status`, ({ request, params }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;

      const id = params.id as string;
      if (id === 'invalid-id') {
        return HttpResponse.json({ error: 'Request not found' }, { status: 404 });
      }
      return HttpResponse.json(makeCompletedStatus(id));
    }),

    // GET — download file (any napkin URL)
    http.get(`${BASE}/visual/:id/file/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return new HttpResponse(mockSvgContent, {
        headers: { 'Content-Type': 'image/svg+xml' },
      });
    }),
  ];
}

/**
 * Creates handlers that return 401 for all Napkin API requests.
 */
export function createNapkinUnauthorizedHandlers() {
  return [
    http.get(`${BASE}/*`, () =>
      HttpResponse.json({ error: 'Invalid API key' }, { status: 401 }),
    ),
    http.post(`${BASE}/*`, () =>
      HttpResponse.json({ error: 'Invalid API key' }, { status: 401 }),
    ),
  ];
}

/**
 * Creates handlers that time out for all Napkin API requests.
 */
export function createNapkinTimeoutHandlers() {
  return [
    http.get(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
    http.post(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
  ];
}

/**
 * Creates bridge mock handlers for Napkin configure flow.
 */
export function createNapkinBridgeHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/napkin/configure`, async ({ request }) => {
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
export function createNapkinBridge401Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/napkin/configure`, () => {
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
export function createNapkinBridge403Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/napkin/configure`, () => {
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
export function createNapkinBridgeFailureHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/napkin/configure`, async ({ request }) => {
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
 * Creates a download handler for specific file URLs.
 */
export function createNapkinDownloadHandlers(expectedApiKey = MOCK_API_KEY) {
  return [
    http.get(`${BASE}/visual/*/file/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return new HttpResponse(mockSvgContent, {
        headers: { 'Content-Type': 'image/svg+xml' },
      });
    }),
  ];
}

/**
 * Creates a download handler that returns 500.
 */
export function createNapkinDownloadFailureHandlers() {
  return [
    http.get(`${BASE}/visual/*/file/*`, () => {
      return HttpResponse.text('Internal Server Error', { status: 500 });
    }),
  ];
}
