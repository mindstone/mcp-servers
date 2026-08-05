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
      // Mirror the real API: action_items are only present when requested.
      const includeActionItems =
        new URL(request.url).searchParams.get('include_action_items') === 'true';
      const items = mockMeetings.map((meeting) =>
        includeActionItems ? meeting : { ...meeting, action_items: undefined },
      );
      return HttpResponse.json({
        limit: 25,
        next_cursor: null,
        items,
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

    // POST /recordings/:id/download — start async download generation
    http.post(`${BASE}/recordings/:id/download`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      const id = Number(params.id);
      if (id === 101 || id === 102) {
        return HttpResponse.json({
          download_id: 'dl_test123',
          recording_id: id,
          status: 'processing',
        });
      }
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }),

    // GET /recordings/:id/downloads/:downloadId — poll download status
    http.get(`${BASE}/recordings/:id/downloads/:downloadId`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      if (params.downloadId === 'dl_test123') {
        return HttpResponse.json({
          download_id: 'dl_test123',
          recording_id: Number(params.id),
          status: 'completed',
          video: {
            url: 'https://media.fathom.ai/downloads/signed-test-url',
            content_type: 'video/mp4',
            file_size_bytes: 154763264,
            expires_at: '2026-01-17T10:00:00Z',
          },
        });
      }
      if (params.downloadId === 'dl_failed') {
        return HttpResponse.json({
          download_id: 'dl_failed',
          recording_id: Number(params.id),
          status: 'failed',
          failure_reason: 'generation_failed',
        });
      }
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }),

    // POST /webhooks — create a webhook
    http.post(`${BASE}/webhooks`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        id: 'wh_test123',
        url: body.destination_url,
        secret: 'whsec_test_secret',
        created_at: '2026-01-16T10:00:00Z',
        include_transcript: body.include_transcript,
        include_summary: body.include_summary,
        include_action_items: body.include_action_items,
        include_crm_matches: body.include_crm_matches,
        triggered_for: body.triggered_for,
      });
    }),

    // DELETE /webhooks/:id — delete a webhook
    http.delete(`${BASE}/webhooks/:id`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      if (params.id === 'wh_test123') {
        return new HttpResponse(null, { status: 204 });
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
