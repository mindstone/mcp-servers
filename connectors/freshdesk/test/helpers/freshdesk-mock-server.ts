import { http, HttpResponse } from 'msw';
import {
  mockTickets,
  mockConversations,
  mockTicketFields,
  mockAgents,
  mockGroups,
  mockContacts,
  mockCompanies,
  mockArticles,
  makeTicket,
  makeContact,
  makeCompany,
  makeArticle,
} from '../fixtures/freshdesk-data.js';

const DOMAIN = 'testacme';
const BASE = `https://${DOMAIN}.freshdesk.com/api/v2`;
const API_KEY = 'mock-test-key';

/**
 * Creates MSW handlers that mock the Freshdesk API.
 * Verifies Basic auth header (base64(apiKey:X)) on every request.
 */
export function createFreshdeskHandlers(
  expectedApiKey = API_KEY,
  domain = DOMAIN,
) {
  const base = `https://${domain}.freshdesk.com/api/v2`;
  const expectedAuth =
    'Basic ' + Buffer.from(`${expectedApiKey}:X`).toString('base64');

  const checkAuth = (request: Request) => {
    const auth = request.headers.get('Authorization');
    if (auth !== expectedAuth) {
      return HttpResponse.json(
        { message: 'Authentication failed', code: 'invalid_credentials' },
        { status: 401 },
      );
    }
    return null;
  };

  return [
    // ── Tickets ───────────────────────────────────────────────────

    // GET /tickets (list)
    http.get(`${base}/tickets`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockTickets);
    }),

    // GET /tickets/:id (get single ticket)
    http.get(`${base}/tickets/:id`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const id = parseInt(params.id as string, 10);

      // Error scenarios
      if (id === 401) {
        return HttpResponse.json(
          { message: 'Authentication failed', code: 'invalid_credentials' },
          { status: 401 },
        );
      }
      if (id === 404) {
        return HttpResponse.json({ message: 'Resource not found' }, { status: 404 });
      }
      if (id === 429) {
        return HttpResponse.json(
          { message: 'Rate limit exceeded' },
          { status: 429, headers: { 'Retry-After': '60' } },
        );
      }

      const url = new URL(request.url);
      const includeConv = url.searchParams.get('include') === 'conversations';

      const ticket = mockTickets.find((t) => t.id === id) || makeTicket(id);

      if (includeConv) {
        return HttpResponse.json({ ...ticket, conversations: mockConversations });
      }
      return HttpResponse.json(ticket);
    }),

    // GET /tickets/:id/conversations
    http.get(`${base}/tickets/:id/conversations`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockConversations);
    }),

    // POST /tickets (create)
    http.post(`${base}/tickets`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(
        makeTicket(42, {
          subject: (body.subject as string) || 'New ticket',
          email: (body.email as string) || 'customer@test.com',
          status: (body.status as number) || 2,
          priority: (body.priority as number) || 1,
          tags: body.tags as string[] | undefined,
        }),
        { status: 201 },
      );
    }),

    // PUT /tickets/:id (update)
    http.put(`${base}/tickets/:id`, async ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const id = parseInt(params.id as string, 10);
      const body = (await request.json()) as Record<string, unknown>;
      const existing = mockTickets.find((t) => t.id === id) || makeTicket(id);

      return HttpResponse.json({
        ...existing,
        ...body,
        id,
      });
    }),

    // POST /tickets/:id/reply
    http.post(`${base}/tickets/:id/reply`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(
        {
          id: 20,
          body: body.body,
          body_text: String(body.body).replace(/<[^>]+>/g, ''),
          incoming: false,
          private: false,
          user_id: 200,
          created_at: '2026-01-15T11:00:00Z',
          updated_at: '2026-01-15T11:00:00Z',
          source: 0,
        },
        { status: 201 },
      );
    }),

    // POST /tickets/:id/notes
    http.post(`${base}/tickets/:id/notes`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(
        {
          id: 21,
          body: body.body,
          body_text: String(body.body).replace(/<[^>]+>/g, ''),
          incoming: false,
          private: body.private !== false,
          user_id: 200,
          created_at: '2026-01-15T11:00:00Z',
          updated_at: '2026-01-15T11:00:00Z',
          source: 0,
        },
        { status: 201 },
      );
    }),

    // ── Search ────────────────────────────────────────────────────

    http.get(`${base}/search/tickets`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      return HttpResponse.json({
        results: [
          makeTicket(5, { subject: 'Search result 1' }),
          makeTicket(6, { subject: 'Search result 2' }),
        ],
        total: 2,
      });
    }),

    // ── Ticket Fields ─────────────────────────────────────────────

    http.get(`${base}/admin/ticket_fields`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockTicketFields);
    }),

    // ── Agents & Groups ───────────────────────────────────────────

    http.get(`${base}/agents`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const url = new URL(request.url);
      const email = url.searchParams.get('email');
      if (email) {
        return HttpResponse.json(
          mockAgents.filter((a) => a.contact?.email === email),
        );
      }
      return HttpResponse.json(mockAgents);
    }),

    http.get(`${base}/groups`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockGroups);
    }),

    // ── Contacts & Companies ──────────────────────────────────────

    http.get(`${base}/contacts`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const url = new URL(request.url);
      const email = url.searchParams.get('email');
      const companyId = url.searchParams.get('company_id');
      let contacts = mockContacts;
      if (email) contacts = contacts.filter((c) => c.email === email);
      if (companyId) contacts = contacts.filter((c) => c.company_id === parseInt(companyId, 10));
      return HttpResponse.json(contacts);
    }),

    http.get(`${base}/contacts/:id`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const id = parseInt(params.id as string, 10);
      if (id === 404) {
        return HttpResponse.json({ message: 'Resource not found' }, { status: 404 });
      }
      const contact = mockContacts.find((c) => c.id === id) || makeContact(id);
      return HttpResponse.json(contact);
    }),

    http.get(`${base}/search/contacts`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({ results: [mockContacts[1]], total: 1 });
    }),

    http.get(`${base}/companies`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockCompanies);
    }),

    http.get(`${base}/companies/:id`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const id = parseInt(params.id as string, 10);
      if (id === 404) {
        return HttpResponse.json({ message: 'Resource not found' }, { status: 404 });
      }
      const company = mockCompanies.find((c) => c.id === id) || makeCompany(id);
      return HttpResponse.json(company);
    }),

    // ── Solutions (knowledge base) ────────────────────────────────

    http.get(`${base}/search/solutions`, ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json(mockArticles);
    }),

    http.get(`${base}/solutions/articles/:id`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;

      const id = parseInt(params.id as string, 10);
      if (id === 404) {
        return HttpResponse.json({ message: 'Resource not found' }, { status: 404 });
      }
      const article = mockArticles.find((a) => a.id === id) || makeArticle(id);
      return HttpResponse.json(article);
    }),
  ];
}

/**
 * Creates a handler that returns 401 for all Freshdesk API requests.
 */
export function createFreshdeskUnauthorizedHandlers(domain = DOMAIN) {
  const base = `https://${domain}.freshdesk.com/api/v2`;
  return [
    http.get(`${base}/*`, () =>
      HttpResponse.json(
        { message: 'Authentication failed', code: 'invalid_credentials' },
        { status: 401 },
      ),
    ),
    http.post(`${base}/*`, () =>
      HttpResponse.json(
        { message: 'Authentication failed', code: 'invalid_credentials' },
        { status: 401 },
      ),
    ),
    http.put(`${base}/*`, () =>
      HttpResponse.json(
        { message: 'Authentication failed', code: 'invalid_credentials' },
        { status: 401 },
      ),
    ),
  ];
}

/**
 * Creates a handler that times out for all Freshdesk API requests.
 */
export function createFreshdeskTimeoutHandlers(domain = DOMAIN) {
  const base = `https://${domain}.freshdesk.com/api/v2`;
  return [
    http.get(`${base}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
    http.post(`${base}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
    http.put(`${base}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
  ];
}

/**
 * Creates a handler that returns 429 rate limit for all Freshdesk API requests.
 */
export function createFreshdeskRateLimitHandlers(domain = DOMAIN) {
  const base = `https://${domain}.freshdesk.com/api/v2`;
  return [
    http.get(`${base}/*`, () =>
      HttpResponse.json(
        { message: 'Rate limit exceeded' },
        { status: 429, headers: { 'Retry-After': '60' } },
      ),
    ),
    http.post(`${base}/*`, () =>
      HttpResponse.json(
        { message: 'Rate limit exceeded' },
        { status: 429, headers: { 'Retry-After': '60' } },
      ),
    ),
    http.put(`${base}/*`, () =>
      HttpResponse.json(
        { message: 'Rate limit exceeded' },
        { status: 429, headers: { 'Retry-After': '60' } },
      ),
    ),
  ];
}

/**
 * Creates bridge mock handlers for Freshdesk configure flow.
 */
export function createFreshdeskBridgeHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/freshdesk/configure`, async ({ request }) => {
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
export function createFreshdeskBridge401Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/freshdesk/configure`, () => {
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
export function createFreshdeskBridge403Handlers(port: number) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/freshdesk/configure`, () => {
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
export function createFreshdeskBridgeFailureHandlers(port: number, token: string) {
  return [
    http.post(`http://127.0.0.1:${port}/bundled/freshdesk/configure`, async ({ request }) => {
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
