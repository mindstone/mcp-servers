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

  async function capture(request: Request): Promise<void> {
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
    const url = new URL(request.url);
    state.requests.push({
      method: request.method,
      url: request.url,
      pathname: url.pathname,
      search: url.search,
      body,
      authorization: request.headers.get('authorization') ?? undefined,
    });
  }

  const handlers: HttpHandler[] = [
    http.post(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      async ({ request }) => {
        state.refreshCalls += 1;
        await capture(request);
        return HttpResponse.json({
          access_token: 'fresh-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope:
            'Chat.Read Chat.ReadWrite Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send offline_access',
        });
      },
    ),

    http.get(`${GRAPH_BASE}/me/chats`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        value: [
          {
            id: 'chat-1',
            topic: 'Project Alpha',
            chatType: 'group',
            createdDateTime: '2026-05-15T10:00:00Z',
            lastUpdatedDateTime: '2026-05-19T10:00:00Z',
          },
          {
            id: 'chat-2',
            topic: null,
            chatType: 'oneOnOne',
            createdDateTime: '2026-05-14T10:00:00Z',
            lastUpdatedDateTime: '2026-05-18T10:00:00Z',
          },
        ],
      });
    }),

    http.get(`${GRAPH_BASE}/me/chats/:chatId/messages`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        value: [
          {
            id: 'msg-1',
            from: { user: { displayName: 'Alice' } },
            body: { content: '<p>Hello &amp; welcome!</p>', contentType: 'html' },
            createdDateTime: '2026-05-19T09:00:00Z',
          },
          {
            id: 'msg-2',
            from: { user: { displayName: 'Bob' } },
            body: { content: 'Follow-up', contentType: 'text' },
            createdDateTime: '2026-05-19T09:05:00Z',
          },
        ],
      });
    }),

    http.get(`${GRAPH_BASE}/me/chats/:chatId/messages/:messageId`, async ({ request, params }) => {
      await capture(request);
      return HttpResponse.json({
        id: String(params.messageId),
        from: { user: { displayName: 'Alice' } },
        body: { content: '<p>Detailed message</p>', contentType: 'html' },
        createdDateTime: '2026-05-19T09:00:00Z',
      });
    }),

    http.post(`${GRAPH_BASE}/me/chats/:chatId/messages`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ id: 'msg-new' });
    }),

    http.post(
      `${GRAPH_BASE}/me/chats/:chatId/messages/:messageId/replies`,
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({ id: 'reply-new' });
      },
    ),

    http.get(`${GRAPH_BASE}/teams/:teamId/channels/:channelId/messages`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        value: [
          {
            id: 'ch-msg-1',
            from: { user: { displayName: 'Carol' } },
            body: { content: '<p>Channel update</p>', contentType: 'html' },
            createdDateTime: '2026-05-19T09:00:00Z',
          },
        ],
      });
    }),

    http.get(
      `${GRAPH_BASE}/teams/:teamId/channels/:channelId/messages/:messageId`,
      async ({ request, params }) => {
        await capture(request);
        return HttpResponse.json({
          id: String(params.messageId),
          from: { user: { displayName: 'Carol' } },
          body: { content: '<p>Channel detail</p>', contentType: 'html' },
          createdDateTime: '2026-05-19T09:00:00Z',
        });
      },
    ),

    http.post(`${GRAPH_BASE}/teams/:teamId/channels/:channelId/messages`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ id: 'ch-msg-new' });
    }),

    http.post(
      `${GRAPH_BASE}/teams/:teamId/channels/:channelId/messages/:messageId/replies`,
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({ id: 'ch-reply-new' });
      },
    ),

    http.post(`${GRAPH_BASE}/search/query`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        value: [
          {
            hitsContainers: [
              {
                hits: [
                  {
                    hitId: 'search-1',
                    summary: '<p>Matched <b>project</b> update</p>',
                    resource: { id: 'msg-1', webUrl: 'https://teams.example.com/message/1' },
                  },
                ],
              },
            ],
          },
        ],
      });
    }),

    http.get(`${GRAPH_BASE}/teams/:teamId/channels`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        value: [
          {
            id: 'channel-1',
            displayName: 'General',
            description: 'Main channel',
            membershipType: 'standard',
          },
          {
            id: 'channel-2',
            displayName: 'Announcements',
            description: 'Announcements channel',
            membershipType: 'standard',
          },
        ],
      });
    }),

    http.get(`${GRAPH_BASE}/me/joinedTeams`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        value: [
          {
            id: 'team-1',
            displayName: 'Engineering',
            description: 'Engineering team',
          },
        ],
      });
    }),
  ];

  return { handlers, state };
}
