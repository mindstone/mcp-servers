import { http, HttpResponse } from 'msw';
import {
  mockMeetings,
  mockTranscript,
  mockSummary,
  mockTeams,
  mockTeamMembers,
} from '../fixtures/fathom-data.js';

const BASE = 'https://api.fathom.ai/external/v1';

/**
 * Creates MSW handlers that mock the Fathom API.
 * Verifies X-Api-Key header on every request.
 */
export function createFathomHandlers(expectedKey = 'test-fathom-key') {
  const checkAuth = (request: Request) => {
    const apiKey = request.headers.get('X-Api-Key');
    if (apiKey !== expectedKey) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return null;
  };

  return [
    // GET /meetings
    http.get(`${BASE}/meetings`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        limit: 25,
        next_cursor: null,
        items: mockMeetings,
      });
    }),

    // GET /recordings/:id/summary
    http.get(`${BASE}/recordings/:id/summary`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      const id = Number(params.id);
      if (id === 101 || id === 102) {
        return HttpResponse.json(mockSummary);
      }
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }),

    // GET /recordings/:id/transcript
    http.get(`${BASE}/recordings/:id/transcript`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      const id = Number(params.id);
      if (id === 101) {
        return HttpResponse.json(mockTranscript);
      }
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }),

    // GET /teams
    http.get(`${BASE}/teams`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        limit: 25,
        next_cursor: null,
        items: mockTeams,
      });
    }),

    // GET /team_members
    http.get(`${BASE}/team_members`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        limit: 25,
        next_cursor: null,
        items: mockTeamMembers,
      });
    }),
  ];
}

/**
 * Creates a handler that returns 401 for all Fathom API requests.
 */
export function createFathomUnauthorizedHandlers() {
  return [
    http.get(`${BASE}/*`, () =>
      HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    ),
  ];
}

/**
 * Creates a handler that times out for all Fathom API requests.
 */
export function createFathomTimeoutHandlers() {
  return [
    http.get(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
  ];
}
