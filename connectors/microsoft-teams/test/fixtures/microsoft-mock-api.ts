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

    http.get(`${GRAPH_BASE}/me/chats/:chatId`, async ({ request, params }) => {
      await capture(request);
      return HttpResponse.json({
        id: String(params.chatId),
        topic: 'Project Alpha',
        chatType: 'group',
        createdDateTime: '2026-05-15T10:00:00Z',
        lastUpdatedDateTime: '2026-05-19T10:00:00Z',
        members: [
          {
            displayName: 'Alice',
            email: 'alice@example.com',
            roles: ['owner'],
          },
        ],
      });
    }),

    http.post(`${GRAPH_BASE}/me/chats/:chatId/messages`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ id: 'msg-new' });
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

    http.get(`${GRAPH_BASE}/teams/:teamId/channels/:channelId/messages`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        value: [
          {
            id: 'channel-msg-1',
            replyToId: null,
            from: { user: { id: 'user-1', displayName: 'Alice' } },
            body: { content: '<p>Quarterly numbers are in</p>', contentType: 'html' },
            createdDateTime: '2026-05-19T08:00:00Z',
          },
          {
            id: 'channel-msg-2',
            replyToId: 'channel-msg-1',
            from: { user: { id: 'user-2', displayName: 'Bob' } },
            body: { content: 'Thanks!', contentType: 'text' },
            createdDateTime: '2026-05-19T08:05:00Z',
          },
        ],
      });
    }),

    http.post(`${GRAPH_BASE}/teams/:teamId/channels/:channelId/messages`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({ id: 'channel-msg-new' });
    }),

    http.post(
      `${GRAPH_BASE}/teams/:teamId/channels/:channelId/messages/:messageId/replies`,
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({ id: 'channel-reply-new' });
      },
    ),

    http.get(`${GRAPH_BASE}/users/:userId`, async ({ request, params }) => {
      await capture(request);
      const userId = String(params.userId);
      if (userId === 'missing%40example.com' || userId === 'missing@example.com') {
        return HttpResponse.json(
          { error: { code: 'Request_ResourceNotFound', message: 'Resource not found' } },
          { status: 404 },
        );
      }
      return HttpResponse.json({
        id: 'user-1',
        displayName: 'Alice Anderson',
        mail: 'alice@example.com',
        userPrincipalName: 'alice@example.com',
      });
    }),

    http.get(`${GRAPH_BASE}/users`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        value: [
          {
            id: 'user-1',
            displayName: 'Alice Anderson',
            mail: 'alice@example.com',
            userPrincipalName: 'alice@example.com',
          },
          {
            id: 'user-2',
            displayName: 'Aaron Baker',
            mail: null,
            userPrincipalName: 'aaron@example.com',
          },
        ],
      });
    }),

    http.post(`${GRAPH_BASE}/chats`, async ({ request }) => {
      await capture(request);
      const body = (await request.clone().json()) as { chatType?: string };
      return HttpResponse.json({ id: 'chat-new', chatType: body.chatType ?? 'oneOnOne' });
    }),

    http.post(`${GRAPH_BASE}/search/query`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        value: [
          {
            hitsContainers: [
              {
                total: 1,
                hits: [
                  {
                    hitId: 'hit-1',
                    summary: '...the <c0>budget</c0> draft is ready...',
                    resource: {
                      id: 'msg-9',
                      chatId: 'chat-1',
                      from: { user: { id: 'user-1', displayName: 'Alice' } },
                      body: {
                        content: '<p>The budget draft is ready</p>',
                        contentType: 'html',
                      },
                      createdDateTime: '2026-05-18T12:00:00Z',
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    }),

    http.get(`${GRAPH_BASE}/me/presence`, async ({ request }) => {
      await capture(request);
      return HttpResponse.json({
        availability: 'Available',
        activity: 'Available',
        statusMessage: {
          message: {
            content: 'Heads down',
          },
        },
      });
    }),
  ];

  return { handlers, state };
}
