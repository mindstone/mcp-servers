import { http, HttpResponse } from 'msw';
import { MOCK_API_KEY, MOCK_DOMAIN } from '../fixtures/talentlms-data.js';
import * as fixtures from '../fixtures/talentlms-data.js';

/**
 * Verify Basic auth header: base64(apiKey:) with colon preserved.
 * Returns an HttpResponse on failure, null on success.
 */
function checkAuth(request: Request, expectedKey = MOCK_API_KEY): HttpResponse | null {
  const auth = request.headers.get('Authorization');
  if (!auth) {
    return HttpResponse.json({ error: { message: 'Unauthorized' } }, { status: 401 });
  }
  const expected = 'Basic ' + Buffer.from(`${expectedKey}:`).toString('base64');
  if (auth !== expected) {
    return HttpResponse.json({ error: { message: 'Unauthorized' } }, { status: 401 });
  }
  return null;
}

const BASE = `https://${MOCK_DOMAIN}.talentlms.com/api/v1`;

/**
 * Apply TalentLMS colon-path pagination (page_size:N,page_number:M) to a
 * fixture array so tests can assert the params are forwarded.
 */
function paginate<T>(items: T[], segment: string): T[] {
  const sizeMatch = segment.match(/page_size:(\d+)/);
  const pageMatch = segment.match(/page_number:(\d+)/);
  const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 20;
  const page = pageMatch ? parseInt(pageMatch[1], 10) : 1;
  return items.slice((page - 1) * size, page * size);
}

function isPaginationSegment(segment: string): boolean {
  return segment.startsWith('page_size:') || segment.startsWith('page_number:');
}

/**
 * Creates MSW handlers for the TalentLMS API.
 * Verifies Basic auth (apiKey:) on every request.
 *
 * Note: TalentLMS uses colon-based URL segments (e.g., /users/id:1).
 * We use wildcard (* path segment) matching to handle these.
 */
export function createTalentLMSHandlers(expectedApiKey = MOCK_API_KEY) {
  return [
    // ─── Users ──────────────────────────────────────────────
    http.get(`${BASE}/users`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      // Check if it's a bare /users or /users/id:xxx
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/api/v1/users') {
        return HttpResponse.json(fixtures.mockUsers);
      }
      return undefined;
    }),

    http.get(`${BASE}/users/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const url = new URL(request.url);
      const path = url.pathname;
      const segment = path.split('/api/v1/users/')[1] || '';

      if (segment.startsWith('id:')) {
        const userId = segment.slice(3);
        if (userId === '999') {
          return HttpResponse.json({ error: { message: 'User not found', type: 'NotFound' } }, { status: 404 });
        }
        return HttpResponse.json(fixtures.mockUserFull);
      }
      if (segment.startsWith('email:')) {
        return HttpResponse.json(fixtures.mockUserFull);
      }
      if (isPaginationSegment(segment)) {
        return HttpResponse.json(paginate(fixtures.mockUsers, segment));
      }
      return HttpResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    }),

    http.post(`${BASE}/usersignup`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(fixtures.mockNewUser);
    }),

    http.get(`${BASE}/usersetstatus/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const url = new URL(request.url);
      const path = url.pathname;
      // Extract status from path like /usersetstatus/user_id:1,status:inactive
      const segment = path.split('/usersetstatus/')[1] || '';
      const statusMatch = segment.match(/status:(\w+)/);
      const status = statusMatch ? statusMatch[1] : 'active';
      return HttpResponse.json({ ...fixtures.mockUsers[0], status });
    }),

    // ─── Courses ────────────────────────────────────────────
    http.get(`${BASE}/courses`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/courses') {
        return HttpResponse.json(fixtures.mockCourses);
      }
      return undefined;
    }),

    http.get(`${BASE}/courses/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const url = new URL(request.url);
      const segment = url.pathname.split('/api/v1/courses/')[1] || '';
      if (isPaginationSegment(segment)) {
        return HttpResponse.json(paginate(fixtures.mockCourses, segment));
      }
      return HttpResponse.json(fixtures.mockCourseFull);
    }),

    http.post(`${BASE}/createcourse`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(fixtures.mockNewCourse);
    }),

    http.post(`${BASE}/addusertocourse`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ message: 'User enrolled' });
    }),

    http.get(`${BASE}/removeuserfromcourse/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ message: 'User removed' });
    }),

    http.get(`${BASE}/gotocourse/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(fixtures.mockSsoLink);
    }),

    // ─── Groups ─────────────────────────────────────────────
    http.get(`${BASE}/groups`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/groups') {
        return HttpResponse.json(fixtures.mockGroups);
      }
      return undefined;
    }),

    http.get(`${BASE}/groups/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const url = new URL(request.url);
      const segment = url.pathname.split('/api/v1/groups/')[1] || '';
      if (isPaginationSegment(segment)) {
        return HttpResponse.json(paginate(fixtures.mockGroups, segment));
      }
      return HttpResponse.json(fixtures.mockGroupFull);
    }),

    http.post(`${BASE}/creategroup`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(fixtures.mockNewGroup);
    }),

    http.get(`${BASE}/addcoursetogroup/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json({ message: 'Course added to group' });
    }),

    // ─── Branches ───────────────────────────────────────────
    http.get(`${BASE}/branches`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/branches') {
        return HttpResponse.json(fixtures.mockBranches);
      }
      return undefined;
    }),

    http.get(`${BASE}/branches/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      const url = new URL(request.url);
      const segment = url.pathname.split('/api/v1/branches/')[1] || '';
      if (isPaginationSegment(segment)) {
        return HttpResponse.json(paginate(fixtures.mockBranches, segment));
      }
      return HttpResponse.json({ error: { message: 'Not found' } }, { status: 404 });
    }),

    // ─── Reporting ──────────────────────────────────────────
    http.get(`${BASE}/siteinfo`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(fixtures.mockSiteInfo);
    }),

    http.get(`${BASE}/gettimeline/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(fixtures.mockTimeline);
    }),

    http.get(`${BASE}/getuserstatusincourse/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(fixtures.mockUserProgress);
    }),

    // ─── Assessments ────────────────────────────────────────
    http.get(`${BASE}/gettestanswers/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(fixtures.mockTestAnswers);
    }),

    http.get(`${BASE}/getsurveyanswers/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(fixtures.mockSurveyAnswers);
    }),

    http.get(`${BASE}/getiltsessions/*`, ({ request }) => {
      const authError = checkAuth(request, expectedApiKey);
      if (authError) return authError;
      return HttpResponse.json(fixtures.mockIltSessions);
    }),
  ];
}

/**
 * Creates a handler that simulates a rate limit (429) for a specific user ID.
 */
export function createRateLimitHandler() {
  return http.get(`${BASE}/users/*`, ({ request }) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.includes('id:rate-limit')) {
      return HttpResponse.json({ error: { message: 'Rate limit exceeded' } }, { status: 429 });
    }
    return undefined;
  });
}

/**
 * Creates a handler that simulates auth failure (401) for a specific user ID.
 */
export function createAuthFailureHandler() {
  return http.get(`${BASE}/users/*`, ({ request }) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.includes('id:auth-fail')) {
      return HttpResponse.json({ error: { message: 'Unauthorized' } }, { status: 401 });
    }
    return undefined;
  });
}

/**
 * Creates a handler that simulates a timeout for the users list endpoint.
 */
export function createTimeoutHandler() {
  return http.get(`${BASE}/users`, async () => {
    await new Promise(() => {/* never resolves */});
  });
}
