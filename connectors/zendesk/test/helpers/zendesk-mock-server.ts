import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  makeTicket,
  makeUser,
  makeGroup,
  makeField,
  makeView,
  makeOrganization,
  makeMacro,
  makeComment,
  makeArticle,
  makeSatisfactionRating,
} from '../fixtures/zendesk-data.js';

export interface ZendeskMockOptions {
  /** Return empty results for all list/search endpoints */
  empty?: boolean;
  /** Return specific error status for all endpoints */
  errorStatus?: number;
  /** Custom tickets to return from search/get */
  tickets?: Array<Record<string, unknown>>;
  /** Custom users to return */
  users?: Array<Record<string, unknown>>;
  /** Custom groups to return */
  groups?: Array<Record<string, unknown>>;
  /** Custom fields to return */
  fields?: Array<Record<string, unknown>>;
  /** Custom views to return */
  views?: Array<Record<string, unknown>>;
  /** Custom organizations to return */
  organizations?: Array<Record<string, unknown>>;
  /** Custom macros to return */
  macros?: Array<Record<string, unknown>>;
  /** Custom comments to return for ticket comments endpoint */
  comments?: Array<Record<string, unknown>>;
  /** Custom Help Center articles to return */
  articles?: Array<Record<string, unknown>>;
  /** Custom satisfaction ratings to return */
  satisfactionRatings?: Array<Record<string, unknown>>;
}

/**
 * Creates MSW handlers that mock the Zendesk REST API.
 * URL patterns match the actual endpoints used by the connector in src/client.ts and src/tools/*.ts.
 */
export function createZendeskHandlers(subdomain: string, options: ZendeskMockOptions = {}): HttpHandler[] {
  const base = `https://${subdomain}.zendesk.com/api/v2`;

  if (options.errorStatus) {
    return createErrorHandlers(base, subdomain, options.errorStatus);
  }

  const defaultTickets = options.empty ? [] : (options.tickets ?? [makeTicket(), makeTicket({ id: 2, subject: 'Second ticket' })]);
  const defaultUsers = options.empty ? [] : (options.users ?? [makeUser()]);
  const defaultGroups = options.empty ? [] : (options.groups ?? [makeGroup()]);
  const defaultFields = options.empty ? [] : (options.fields ?? [makeField()]);
  const defaultViews = options.empty ? [] : (options.views ?? [makeView()]);
  const defaultOrganizations = options.empty ? [] : (options.organizations ?? [makeOrganization()]);
  const defaultMacros = options.empty ? [] : (options.macros ?? [makeMacro()]);
  const defaultComments = options.empty ? [] : (options.comments ?? [makeComment()]);
  const defaultArticles = options.empty ? [] : (options.articles ?? [makeArticle()]);
  const defaultRatings = options.empty ? [] : (options.satisfactionRatings ?? [makeSatisfactionRating()]);

  return [
    // Search (used by search_zendesk_tickets, search_zendesk_users)
    http.get(`${base}/search.json`, () => {
      return HttpResponse.json({
        results: defaultTickets,
        count: defaultTickets.length,
        next_page: null,
        previous_page: null,
      });
    }),

    // Search Export (used by export_zendesk_tickets)
    http.get(`${base}/search/export.json`, () => {
      return HttpResponse.json({
        results: defaultTickets,
        meta: { has_more: false, after_cursor: '' },
        links: { next: '' },
      });
    }),

    // Get single ticket
    http.get(`${base}/tickets/:ticketId.json`, ({ params }) => {
      const ticketId = Number(params.ticketId);
      const ticket = defaultTickets.find(t => (t as { id: number }).id === ticketId) ?? makeTicket({ id: ticketId });
      return HttpResponse.json({ ticket });
    }),

    // Show many tickets
    http.get(`${base}/tickets/show_many.json`, ({ request }) => {
      const url = new URL(request.url);
      const idsParam = url.searchParams.get('ids') ?? '';
      const requestedIds = idsParam.split(',').map(Number).filter(Boolean);
      const tickets = requestedIds.map(id =>
        defaultTickets.find(t => (t as { id: number }).id === id) ?? makeTicket({ id })
      );
      return HttpResponse.json({ tickets });
    }),

    // Create ticket
    http.post(`${base}/tickets.json`, async ({ request }) => {
      const body = await request.json() as { ticket: Record<string, unknown> };
      const ticket = makeTicket({
        id: 99999,
        subject: body.ticket?.subject as string ?? 'New ticket',
        status: 'new',
      });
      return HttpResponse.json({ ticket }, { status: 201 });
    }),

    // Update ticket
    http.put(`${base}/tickets/:ticketId.json`, ({ params }) => {
      const ticketId = Number(params.ticketId);
      const ticket = makeTicket({ id: ticketId });
      return HttpResponse.json({ ticket });
    }),

    // Ticket comments
    http.get(`${base}/tickets/:ticketId/comments.json`, () => {
      return HttpResponse.json({
        comments: defaultComments,
        next_page: null,
        count: defaultComments.length,
      });
    }),

    // Get single user
    http.get(`${base}/users/:userId.json`, ({ params }) => {
      const userId = Number(params.userId);
      const user = defaultUsers.find(u => (u as { id: number }).id === userId) ?? makeUser({ id: userId });
      return HttpResponse.json({ user });
    }),

    // Create or update user
    http.post(`${base}/users/create_or_update.json`, async ({ request }) => {
      const body = await request.json() as { user: Record<string, unknown> };
      const user = makeUser({
        id: 101,
        name: body.user?.name as string ?? 'New User',
        email: body.user?.email as string ?? 'new@example.com',
        organization_id: body.user?.organization_id as number | undefined,
      });
      return HttpResponse.json({ user }, { status: 201 });
    }),

    // Show many users
    http.get(`${base}/users/show_many.json`, ({ request }) => {
      const url = new URL(request.url);
      const idsParam = url.searchParams.get('ids') ?? '';
      const requestedIds = idsParam.split(',').map(Number).filter(Boolean);
      const users = requestedIds.map(id =>
        defaultUsers.find(u => (u as { id: number }).id === id) ?? makeUser({ id })
      );
      return HttpResponse.json({ users });
    }),

    // Groups
    http.get(`${base}/groups.json`, () => {
      return HttpResponse.json({ groups: defaultGroups });
    }),

    // Ticket fields
    http.get(`${base}/ticket_fields.json`, () => {
      return HttpResponse.json({ ticket_fields: defaultFields });
    }),

    // Views
    http.get(`${base}/views.json`, () => {
      return HttpResponse.json({ views: defaultViews });
    }),

    // View tickets (used by list_zendesk_view_tickets)
    http.get(`${base}/views/:viewId/tickets.json`, () => {
      return HttpResponse.json({
        tickets: defaultTickets,
        count: defaultTickets.length,
        next_page: null,
      });
    }),

    // Organizations
    http.get(`${base}/organizations.json`, () => {
      return HttpResponse.json({
        organizations: defaultOrganizations,
        count: defaultOrganizations.length,
        next_page: null,
      });
    }),

    // Get single organization
    http.get(`${base}/organizations/:organizationId.json`, ({ params }) => {
      const organizationId = Number(params.organizationId);
      const organization =
        defaultOrganizations.find(o => (o as { id: number }).id === organizationId)
        ?? makeOrganization({ id: organizationId });
      return HttpResponse.json({ organization });
    }),

    // Macros - list
    http.get(`${base}/macros.json`, () => {
      return HttpResponse.json({
        macros: defaultMacros,
        count: defaultMacros.length,
        next_page: null,
      });
    }),

    // Macros - search
    http.get(`${base}/macros/search.json`, () => {
      return HttpResponse.json({
        results: defaultMacros,
        count: defaultMacros.length,
        next_page: null,
      });
    }),

    // Get single macro
    http.get(`${base}/macros/:macroId.json`, ({ params }) => {
      const macroId = Number(params.macroId);
      const macro = defaultMacros.find(m => (m as { id: number }).id === macroId) ?? makeMacro({ id: macroId });
      return HttpResponse.json({ macro });
    }),

    // Apply macro to ticket (preview)
    http.get(`${base}/tickets/:ticketId/macros/:macroId/apply.json`, () => {
      return HttpResponse.json({
        result: {
          ticket: {
            status: 'solved',
            priority: 'high',
            comment: { body: 'Macro applied', public: true },
          },
        },
      });
    }),

    // Help Center article search (used by search_zendesk_help_center_articles)
    http.get(`${base}/help_center/articles/search.json`, () => {
      return HttpResponse.json({
        results: defaultArticles,
        count: defaultArticles.length,
        next_page: null,
      });
    }),

    // Get single Help Center article
    http.get(`${base}/help_center/articles/:articleId.json`, ({ params }) => {
      const articleId = Number(params.articleId);
      const article = defaultArticles.find(a => (a as { id: number }).id === articleId) ?? makeArticle({ id: articleId });
      return HttpResponse.json({ article });
    }),

    // Satisfaction ratings (used by list_zendesk_satisfaction_ratings)
    http.get(`${base}/satisfaction_ratings.json`, () => {
      return HttpResponse.json({
        satisfaction_ratings: defaultRatings,
        count: defaultRatings.length,
        next_page: null,
      });
    }),

    // OAuth token refresh (outside /api/v2)
    http.post(`https://${subdomain}.zendesk.com/oauth/tokens`, () => {
      return HttpResponse.json({
        access_token: 'refreshed-access-token',
        refresh_token: 'refreshed-refresh-token',
        expires_in: 7200,
        token_type: 'bearer',
      });
    }),
  ];
}

/**
 * Creates handlers that return an error status for all Zendesk API endpoints.
 */
function createErrorHandlers(base: string, subdomain: string, status: number): HttpHandler[] {
  const errorResponse = () =>
    HttpResponse.json(
      { error: `Mock error ${status}`, description: `Simulated ${status} error` },
      { status },
    );

  return [
    http.get(`${base}/*`, errorResponse),
    http.post(`${base}/*`, errorResponse),
    http.put(`${base}/*`, errorResponse),
    http.post(`https://${subdomain}.zendesk.com/oauth/tokens`, errorResponse),
  ];
}
