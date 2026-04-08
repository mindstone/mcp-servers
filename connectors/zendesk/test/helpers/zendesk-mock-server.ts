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

    // Organizations
    http.get(`${base}/organizations.json`, () => {
      return HttpResponse.json({
        organizations: defaultOrganizations,
        count: defaultOrganizations.length,
        next_page: null,
      });
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
