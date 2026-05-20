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
          scope: 'Mail.ReadWrite Mail.Send offline_access',
        });
      },
    ),

    // /me/mailFolders/{folder}/messages — list_emails
    http.get(`${GRAPH_BASE}/me/mailFolders/:folder/messages`, async ({ request, params }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({
        value: [
          {
            id: 'msg-1',
            subject: 'Welcome',
            from: { emailAddress: { address: 'alice@example.com', name: 'Alice' } },
            receivedDateTime: '2026-05-19T10:00:00Z',
            bodyPreview: 'Welcome to the inbox',
            isRead: false,
            hasAttachments: false,
            importance: 'normal',
          },
          {
            id: 'msg-2',
            subject: 'Meeting tomorrow',
            from: { emailAddress: { address: 'bob@example.com', name: 'Bob' } },
            receivedDateTime: '2026-05-19T09:00:00Z',
            bodyPreview: 'Let us meet at 3pm',
            isRead: true,
            hasAttachments: true,
            importance: 'high',
          },
        ],
        folder: String(params.folder),
      });
    }),

    // /me/messages/{id} (GET)
    http.get(`${GRAPH_BASE}/me/messages/:id`, async ({ request, params }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({
        id: String(params.id),
        subject: 'Welcome',
        from: { emailAddress: { address: 'alice@example.com', name: 'Alice' } },
        toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
        ccRecipients: [],
        receivedDateTime: '2026-05-19T10:00:00Z',
        body: { content: '<p>Hi</p>', contentType: 'HTML' },
        isRead: true,
        hasAttachments: false,
        importance: 'normal',
      });
    }),

    // /me/messages — search_emails uses GET with $search query param
    http.get(`${GRAPH_BASE}/me/messages`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({
        value: [
          {
            id: 'msg-1',
            subject: 'project update',
            from: { emailAddress: { address: 'alice@example.com' } },
            receivedDateTime: '2026-05-19T10:00:00Z',
            bodyPreview: 'Status update on the project',
            isRead: false,
          },
        ],
      });
    }),

    // /me/messages — create_draft uses POST to /me/messages
    http.post(`${GRAPH_BASE}/me/messages`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({ id: 'draft-1', subject: 'Test draft' });
    }),

    // /me/sendMail (POST)
    http.post(`${GRAPH_BASE}/me/sendMail`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return new HttpResponse(null, { status: 202 });
    }),

    // /me/messages/{id}/reply, /replyAll, /forward, /move, /createReply, /createReplyAll
    http.post(`${GRAPH_BASE}/me/messages/:id/:action`, async ({ request, params }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      const action = String(params.action);
      if (action === 'createReply' || action === 'createReplyAll') {
        return HttpResponse.json({
          id: 'draft-reply-1',
          conversationId: 'conv-1',
          subject: 'Re: Welcome',
        });
      }
      if (action === 'move') {
        return HttpResponse.json({ id: 'moved-1' });
      }
      return new HttpResponse(null, { status: 202 });
    }),

    // /me/messages/{id} (DELETE) — permanent delete
    http.delete(`${GRAPH_BASE}/me/messages/:id`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return new HttpResponse(null, { status: 204 });
    }),

    // /me/mailFolders — list_folders
    http.get(`${GRAPH_BASE}/me/mailFolders`, async ({ request }) => {
      const url = new URL(request.url);
      await capture(request, url.pathname, url.search);
      return HttpResponse.json({
        value: [
          {
            id: 'folder-inbox',
            displayName: 'Inbox',
            totalItemCount: 12,
            unreadItemCount: 3,
            childFolderCount: 0,
          },
          {
            id: 'folder-sent',
            displayName: 'Sent Items',
            totalItemCount: 5,
            unreadItemCount: 0,
            childFolderCount: 0,
          },
        ],
      });
    }),
  ];

  return { handlers, state };
}
