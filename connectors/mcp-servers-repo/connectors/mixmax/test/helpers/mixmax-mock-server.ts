import { http, HttpResponse } from 'msw';
import {
  mockSequences,
  mockSequenceDetail,
  mockMessages,
  mockSnippets,
  mockMeetingTypes,
  mockUser,
  mockSendResult,
  mockAddRecipientsResult,
  mockSnippetSendResult,
} from '../fixtures/mixmax-data.js';

const BASE = 'https://api.mixmax.com/v1';

/**
 * Creates MSW handlers that mock the Mixmax API.
 * Verifies X-API-Token header on every request.
 */
export function createMixmaxHandlers(expectedToken = 'test-mixmax-token') {
  const checkAuth = (request: Request) => {
    const token = request.headers.get('X-API-Token');
    if (token !== expectedToken) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return null;
  };

  return [
    // GET /sequences
    http.get(`${BASE}/sequences`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        results: mockSequences,
        hasNext: false,
      });
    }),

    // GET /sequences/:id
    http.get(`${BASE}/sequences/:id`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      if (params.id === 'seq-001') {
        return HttpResponse.json(mockSequenceDetail);
      }
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }),

    // POST /sequences/:id/recipients
    http.post(`${BASE}/sequences/:id/recipients`, async ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      if (params.id === 'seq-001') {
        return HttpResponse.json(mockAddRecipientsResult);
      }
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }),

    // GET /messages
    http.get(`${BASE}/messages`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        results: mockMessages,
        hasNext: false,
      });
    }),

    // POST /send
    http.post(`${BASE}/send`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockSendResult);
    }),

    // GET /snippets
    http.get(`${BASE}/snippets`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        results: mockSnippets,
        hasNext: false,
      });
    }),

    // POST /snippets/:id/send
    http.post(`${BASE}/snippets/:id/send`, async ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      if (params.id === 'snip-001') {
        return HttpResponse.json(mockSnippetSendResult);
      }
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }),

    // GET /meetingtypes
    http.get(`${BASE}/meetingtypes`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        results: mockMeetingTypes,
      });
    }),

    // GET /users/me
    http.get(`${BASE}/users/me`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockUser);
    }),
  ];
}

/**
 * Creates a handler that returns 401 for all Mixmax API requests.
 */
export function createMixmaxUnauthorizedHandlers() {
  return [
    http.get(`${BASE}/*`, () =>
      HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    ),
    http.post(`${BASE}/*`, () =>
      HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    ),
  ];
}

/**
 * Creates a handler that times out for all Mixmax API requests.
 */
export function createMixmaxTimeoutHandlers() {
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
