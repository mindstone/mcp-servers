import { http, HttpResponse } from 'msw';
import {
  mockMe,
  mockPeople,
  mockJobRoles,
  mockLocations,
  mockCompany,
  mockTimeAway,
  mockTimeAwayTypes,
  mockCreatedTimeAway,
  mockTimeAwayAllocations,
} from '../fixtures/humaans-data.js';

const BASE = 'https://app.humaans.io/api';

/**
 * Creates MSW handlers that mock the Humaans API.
 * Verifies Authorization: Bearer header on every request.
 */
export function createHumaansHandlers(expectedKey = 'test-humaans-key') {
  const checkAuth = (request: Request) => {
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${expectedKey}`) {
      return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return null;
  };

  return [
    // GET /me
    http.get(`${BASE}/me`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockMe);
    }),

    // GET /people
    http.get(`${BASE}/people`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        total: mockPeople.length,
        limit: 50,
        skip: 0,
        data: mockPeople,
      });
    }),

    // GET /people/:id
    http.get(`${BASE}/people/:id`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      const person = mockPeople.find((p) => p.id === params.id);
      if (!person) {
        return HttpResponse.json(
          { code: 404, name: 'NotFound', message: 'Person not found' },
          { status: 404 },
        );
      }
      return HttpResponse.json({ ...person, bio: 'A great engineer', socialLinks: [] });
    }),

    // GET /job-roles
    http.get(`${BASE}/job-roles`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        total: mockJobRoles.length,
        limit: 100,
        skip: 0,
        data: mockJobRoles,
      });
    }),

    // GET /job-roles/:id
    http.get(`${BASE}/job-roles/:id`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      const role = mockJobRoles.find((r) => r.id === params.id);
      if (!role) {
        return HttpResponse.json(
          { code: 404, name: 'NotFound', message: 'Job role not found' },
          { status: 404 },
        );
      }
      return HttpResponse.json(role);
    }),

    // GET /locations
    http.get(`${BASE}/locations`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        total: mockLocations.length,
        limit: 100,
        skip: 0,
        data: mockLocations,
      });
    }),

    // GET /companies
    http.get(`${BASE}/companies`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        total: 1,
        limit: 100,
        skip: 0,
        data: [mockCompany],
      });
    }),

    // GET /time-away
    http.get(`${BASE}/time-away`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        total: mockTimeAway.length,
        limit: 50,
        skip: 0,
        data: mockTimeAway,
      });
    }),

    // POST /time-away
    http.post(`${BASE}/time-away`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockCreatedTimeAway, { status: 201 });
    }),

    // DELETE /time-away/:id
    http.delete(`${BASE}/time-away/:id`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      const entry = mockTimeAway.find((t) => t.id === params.id);
      if (!entry) {
        return HttpResponse.json(
          { code: 404, name: 'NotFound', message: 'Time away not found' },
          { status: 404 },
        );
      }
      return HttpResponse.json({ id: params.id, deleted: true });
    }),

    // PATCH /time-away/:id
    http.patch(`${BASE}/time-away/:id`, async ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      const entry = mockTimeAway.find((t) => t.id === params.id);
      if (!entry) {
        return HttpResponse.json(
          { code: 404, name: 'NotFound', message: 'Time away not found' },
          { status: 404 },
        );
      }
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        ...entry,
        ...body,
        reviewedAt: '2024-04-10',
      });
    }),

    // GET /time-away-types
    http.get(`${BASE}/time-away-types`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        total: mockTimeAwayTypes.length,
        limit: 100,
        skip: 0,
        data: mockTimeAwayTypes,
      });
    }),

    // GET /time-away-allocations
    http.get(`${BASE}/time-away-allocations`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        total: mockTimeAwayAllocations.length,
        limit: 100,
        skip: 0,
        data: mockTimeAwayAllocations,
      });
    }),
  ];
}

/**
 * Creates a handler that returns 401 for all Humaans API requests.
 */
export function createHumaansUnauthorizedHandlers() {
  return [
    http.all(`${BASE}/*`, () =>
      HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    ),
  ];
}

/**
 * Creates a handler that times out for all Humaans API requests.
 */
export function createHumaansTimeoutHandlers() {
  return [
    http.all(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
  ];
}
