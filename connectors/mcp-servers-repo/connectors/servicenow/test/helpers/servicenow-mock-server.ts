import { http, HttpResponse } from 'msw';
import {
  mockIncidents,
  mockIncidentDetail,
  mockChangeRequests,
  mockChangeRequestDetail,
  mockKnowledgeArticles,
  mockKnowledgeArticleDetail,
  mockUsers,
} from '../fixtures/servicenow-data.js';

const INSTANCE = 'test-instance';
const BASE = `https://${INSTANCE}.service-now.com/api/now/table`;

/**
 * Creates MSW handlers that mock the ServiceNow Table API.
 * Verifies `Authorization: Basic base64(username:password)` on every request.
 */
export function createServiceNowHandlers(
  expectedUsername = 'test-user',
  expectedPassword = 'test-pass',
) {
  const expectedAuth =
    'Basic ' + Buffer.from(`${expectedUsername}:${expectedPassword}`).toString('base64');

  const checkAuth = (request: Request) => {
    const auth = request.headers.get('Authorization');
    if (auth !== expectedAuth) {
      return HttpResponse.json(
        { error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' } },
        { status: 401 },
      );
    }
    return null;
  };

  return [
    // ── Incidents ─────────────────────────────────────────────────

    // GET /incident (list)
    http.get(`${BASE}/incident`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const url = new URL(request.url);
      const query = url.searchParams.get('sysparm_query') || '';

      // Filter by query if present
      let filtered = mockIncidents;
      if (query.includes('number=')) {
        const numberMatch = query.match(/number=([A-Z0-9]+)/);
        if (numberMatch) {
          filtered = mockIncidents.filter((i) => i.number === numberMatch[1]);
        }
      }

      return HttpResponse.json({ result: filtered });
    }),

    // GET /incident/:sys_id (get by sys_id)
    http.get(`${BASE}/incident/:sysId`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const sysId = params.sysId as string;
      const incident = mockIncidents.find((i) => i.sys_id === sysId);
      if (!incident) {
        return HttpResponse.json(
          { error: { message: 'Record not found', detail: `Could not find record for sys_id: ${sysId}` } },
          { status: 404 },
        );
      }
      return HttpResponse.json({ result: incident });
    }),

    // POST /incident (create)
    http.post(`${BASE}/incident`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const body = (await request.json()) as Record<string, string>;
      const created = {
        ...mockIncidentDetail,
        number: 'INC0010099',
        sys_id: 'new-incident-sys-id',
        short_description: body.short_description || 'No description',
        urgency: body.urgency || '3',
        impact: body.impact || '3',
      };
      return HttpResponse.json({ result: created });
    }),

    // PATCH /incident/:sys_id (update)
    http.patch(`${BASE}/incident/:sysId`, async ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const sysId = params.sysId as string;
      const incident = mockIncidents.find((i) => i.sys_id === sysId);
      if (!incident) {
        return HttpResponse.json(
          { error: { message: 'Record not found' } },
          { status: 404 },
        );
      }

      const body = (await request.json()) as Record<string, string>;
      return HttpResponse.json({
        result: { ...incident, ...body },
      });
    }),

    // ── Change Requests ───────────────────────────────────────────

    // GET /change_request (list)
    http.get(`${BASE}/change_request`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const url = new URL(request.url);
      const query = url.searchParams.get('sysparm_query') || '';

      let filtered = mockChangeRequests;
      if (query.includes('number=')) {
        const numberMatch = query.match(/number=([A-Z0-9]+)/);
        if (numberMatch) {
          filtered = mockChangeRequests.filter((c) => c.number === numberMatch[1]);
        }
      }

      return HttpResponse.json({ result: filtered });
    }),

    // GET /change_request/:sys_id (get by sys_id)
    http.get(`${BASE}/change_request/:sysId`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const sysId = params.sysId as string;
      const cr = mockChangeRequests.find((c) => c.sys_id === sysId);
      if (!cr) {
        return HttpResponse.json(
          { error: { message: 'Record not found' } },
          { status: 404 },
        );
      }
      return HttpResponse.json({ result: cr });
    }),

    // ── Knowledge ─────────────────────────────────────────────────

    // GET /kb_knowledge (search/list)
    http.get(`${BASE}/kb_knowledge`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const url = new URL(request.url);
      const query = url.searchParams.get('sysparm_query') || '';

      let filtered = mockKnowledgeArticles;
      if (query.includes('number=')) {
        const numberMatch = query.match(/number=([A-Z0-9]+)/);
        if (numberMatch) {
          filtered = mockKnowledgeArticles.filter((a) => a.number === numberMatch[1]);
        }
      } else if (query.includes('LIKE')) {
        // Keyword search: filter by short_description
        const likeMatch = query.match(/short_descriptionLIKE([^^]+)/);
        if (likeMatch) {
          const keyword = likeMatch[1].toLowerCase();
          filtered = mockKnowledgeArticles.filter(
            (a) => a.short_description.toLowerCase().includes(keyword),
          );
        }
      }

      return HttpResponse.json({ result: filtered });
    }),

    // GET /kb_knowledge/:sys_id (get by sys_id)
    http.get(`${BASE}/kb_knowledge/:sysId`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const sysId = params.sysId as string;
      if (sysId === mockKnowledgeArticleDetail.sys_id) {
        return HttpResponse.json({ result: mockKnowledgeArticleDetail });
      }
      return HttpResponse.json(
        { error: { message: 'Record not found' } },
        { status: 404 },
      );
    }),

    // ── Users ─────────────────────────────────────────────────────

    // GET /sys_user (list)
    http.get(`${BASE}/sys_user`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      return HttpResponse.json({ result: mockUsers });
    }),
  ];
}

/**
 * Creates a handler that returns 401 for all ServiceNow API requests.
 */
export function createServiceNowUnauthorizedHandlers() {
  return [
    http.get(`${BASE}/*`, () =>
      HttpResponse.json(
        { error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' } },
        { status: 401 },
      ),
    ),
    http.post(`${BASE}/*`, () =>
      HttpResponse.json(
        { error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' } },
        { status: 401 },
      ),
    ),
    http.patch(`${BASE}/*`, () =>
      HttpResponse.json(
        { error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' } },
        { status: 401 },
      ),
    ),
  ];
}

/**
 * Creates a handler that times out for all ServiceNow API requests.
 */
export function createServiceNowTimeoutHandlers() {
  return [
    http.get(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
    http.post(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
    http.patch(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
  ];
}

/**
 * Creates a handler that returns 429 rate limit for all ServiceNow API requests.
 */
export function createServiceNowRateLimitHandlers() {
  return [
    http.get(`${BASE}/*`, () =>
      HttpResponse.json(
        { error: { message: 'Rate limit exceeded' } },
        { status: 429 },
      ),
    ),
    http.post(`${BASE}/*`, () =>
      HttpResponse.json(
        { error: { message: 'Rate limit exceeded' } },
        { status: 429 },
      ),
    ),
    http.patch(`${BASE}/*`, () =>
      HttpResponse.json(
        { error: { message: 'Rate limit exceeded' } },
        { status: 429 },
      ),
    ),
  ];
}
