import { http, HttpResponse, type DefaultBodyType, type HttpHandler } from 'msw';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface CapturedRequest {
  method: string;
  url: string;
  pathname: string;
  search: string;
  body: DefaultBodyType | null;
  authorization?: string;
}

export interface MockApiState {
  requests: CapturedRequest[];
  refreshCalls: number;
}

export function createMockApi(): { handlers: HttpHandler[]; state: MockApiState } {
  const state: MockApiState = { requests: [], refreshCalls: 0 };

  async function capture(
    request: Request,
    pathname: string,
    search: string,
  ): Promise<void> {
    let body: DefaultBodyType | null = null;
    try {
      const ct = request.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        body = (await request.clone().json()) as DefaultBodyType;
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        const text = await request.clone().text();
        body = Object.fromEntries(new URLSearchParams(text).entries()) as DefaultBodyType;
      } else {
        body = (await request.clone().text()) as DefaultBodyType;
      }
    } catch {
      body = null;
    }
    state.requests.push({
      method: request.method,
      url: request.url,
      pathname,
      search,
      body,
      authorization: request.headers.get('authorization') ?? undefined,
    });
  }

  const handlers: HttpHandler[] = [
    // Refresh-token endpoint (used by TokenProvider on expiry).
    http.post(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      async ({ request }) => {
        state.refreshCalls += 1;
        await capture(request, '/common/oauth2/v2.0/token', '');
        return HttpResponse.json({
          access_token: 'fresh-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'Calendars.ReadWrite MailboxSettings.Read offline_access',
        });
      },
    ),

    // /me/mailboxSettings — used by the timezone resolver
    http.get(`${GRAPH_BASE}/me/mailboxSettings`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({ timeZone: 'Pacific Standard Time' });
    }),

    // /me/calendarView — list_events (default calendar)
    http.get(`${GRAPH_BASE}/me/calendarView`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({
        value: [
          {
            id: 'event-1',
            subject: 'Team Standup',
            start: { dateTime: '2026-05-20T09:00:00', timeZone: 'Pacific Standard Time' },
            end: { dateTime: '2026-05-20T09:30:00', timeZone: 'Pacific Standard Time' },
            location: { displayName: 'Room A' },
            organizer: { emailAddress: { address: 'alice@example.com', name: 'Alice' } },
            attendees: [{ emailAddress: { address: 'bob@example.com' } }],
            isAllDay: false,
            webLink: 'https://outlook.com/event-1',
          },
          {
            id: 'event-2',
            subject: 'All-hands',
            start: { dateTime: '2026-05-20T10:00:00', timeZone: 'Pacific Standard Time' },
            end: { dateTime: '2026-05-20T11:00:00', timeZone: 'Pacific Standard Time' },
            isAllDay: false,
            webLink: 'https://outlook.com/event-2',
          },
        ],
      });
    }),

    // /me/calendars/{calendarId}/calendarView
    http.get(`${GRAPH_BASE}/me/calendars/:calendarId/calendarView`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({ value: [] });
    }),

    // /me/events/{id} (GET)
    http.get(`${GRAPH_BASE}/me/events/:id`, async ({ request, params }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({
        id: String(params.id),
        subject: 'Team Standup',
        start: { dateTime: '2026-05-20T09:00:00', timeZone: 'Pacific Standard Time' },
        end: { dateTime: '2026-05-20T09:30:00', timeZone: 'Pacific Standard Time' },
        location: { displayName: 'Room A' },
        body: { content: 'Daily sync', contentType: 'Text' },
        organizer: { emailAddress: { address: 'alice@example.com', name: 'Alice' } },
        attendees: [
          {
            emailAddress: { address: 'bob@example.com', name: 'Bob' },
            status: { response: 'accepted' },
          },
        ],
        isAllDay: false,
        webLink: 'https://outlook.com/event-1',
        onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup/abc' },
      });
    }),

    // /me/events (POST) — create_event
    http.post(`${GRAPH_BASE}/me/events`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({
        id: 'new-event-1',
        webLink: 'https://outlook.com/new-event-1',
        onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup/new' },
      });
    }),

    // /me/events/{id} (PATCH) — update_event
    http.patch(`${GRAPH_BASE}/me/events/:id`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({ id: 'updated-1' });
    }),

    // /me/events/{id} (DELETE) — delete_event
    http.delete(`${GRAPH_BASE}/me/events/:id`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return new HttpResponse(null, { status: 204 });
    }),

    // /me/events/{id}/accept | decline | tentative — respond_to_event
    http.post(`${GRAPH_BASE}/me/events/:id/:action`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return new HttpResponse(null, { status: 202 });
    }),

    // /me/calendar/getSchedule (POST) — get_free_busy
    http.post(`${GRAPH_BASE}/me/calendar/getSchedule`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({
        value: [
          {
            scheduleId: 'alice@example.com',
            availabilityView: '000000',
            scheduleItems: [
              {
                status: 'busy',
                start: { dateTime: '2026-05-20T09:00:00', timeZone: 'Pacific Standard Time' },
                end: { dateTime: '2026-05-20T09:30:00', timeZone: 'Pacific Standard Time' },
                subject: 'Team Standup',
              },
            ],
          },
        ],
      });
    }),

    // /me/calendars (GET) — list_calendars
    http.get(`${GRAPH_BASE}/me/calendars`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({
        value: [
          {
            id: 'cal-1',
            name: 'My Calendar',
            color: 'auto',
            isDefaultCalendar: true,
            canEdit: true,
            owner: { name: 'Test User', address: 'user@example.com' },
          },
          {
            id: 'cal-2',
            name: 'Team Calendar',
            color: 'lightGreen',
            isDefaultCalendar: false,
            canEdit: false,
          },
        ],
      });
    }),
  ];

  return { handlers, state };
}
