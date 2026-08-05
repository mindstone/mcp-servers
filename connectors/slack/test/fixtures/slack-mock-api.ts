/**
 * MSW handlers for Slack Web API endpoints used by tests.
 *
 * Every handler URL MUST also be a string referenced in production code (in
 * `src/**`). The msw-manifest test enforces this invariant — adding a new
 * handler here without using its URL in production fails the manifest check
 * and vice versa. (Closes the retell-ai 0.1.2 class of MSW/production drift.)
 */
import { http, HttpResponse } from 'msw';

export const SLACK_API_BASE = 'https://slack.com/api';

/**
 * The set of Slack API URLs used by the production code. Must be kept in
 * sync with `src/**` references via the msw-manifest test.
 */
export const SLACK_PRODUCTION_API_URLS: string[] = [
  `${SLACK_API_BASE}/assistant.search.context`,
  `${SLACK_API_BASE}/auth.test`,
  `${SLACK_API_BASE}/bookmarks.add`,
  `${SLACK_API_BASE}/chat.postMessage`,
  `${SLACK_API_BASE}/chat.scheduleMessage`,
  `${SLACK_API_BASE}/chat.scheduledMessages.list`,
  `${SLACK_API_BASE}/chat.deleteScheduledMessage`,
  `${SLACK_API_BASE}/conversations.create`,
  `${SLACK_API_BASE}/conversations.history`,
  `${SLACK_API_BASE}/conversations.info`,
  `${SLACK_API_BASE}/conversations.invite`,
  `${SLACK_API_BASE}/conversations.list`,
  `${SLACK_API_BASE}/conversations.mark`,
  `${SLACK_API_BASE}/conversations.open`,
  `${SLACK_API_BASE}/conversations.replies`,
  `${SLACK_API_BASE}/files.info`,
  `${SLACK_API_BASE}/oauth.v2.access`,
  `${SLACK_API_BASE}/reactions.add`,
  `${SLACK_API_BASE}/reminders.add`,
  `${SLACK_API_BASE}/search.messages`,
  `${SLACK_API_BASE}/users.info`,
  `${SLACK_API_BASE}/users.list`,
  `${SLACK_API_BASE}/users.lookupByEmail`,
];

const TEAM_ID = 'T123';
const TEAM_NAME = 'Test Workspace';

export function createSlackHandlers() {
  return [
    http.post(`${SLACK_API_BASE}/auth.test`, () =>
      HttpResponse.json({
        ok: true,
        team: TEAM_NAME,
        user: 'testuser',
        team_id: TEAM_ID,
        user_id: 'U123',
      }),
    ),
    http.post(`${SLACK_API_BASE}/chat.postMessage`, async ({ request }) => {
      const body = await request.text();
      const params = new URLSearchParams(body);
      const channel = params.get('channel') || 'C123TEST';
      const text = params.get('text') || 'Hello world';
      return HttpResponse.json({
        ok: true,
        channel,
        ts: '1704067200.123456',
        message: { text, ts: '1704067200.123456' },
      });
    }),
    http.post(`${SLACK_API_BASE}/chat.scheduleMessage`, () =>
      HttpResponse.json({
        ok: true,
        channel: 'C123TEST',
        scheduled_message_id: 'Q1234ABCD',
        post_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    ),
    http.post(`${SLACK_API_BASE}/chat.scheduledMessages.list`, () =>
      HttpResponse.json({
        ok: true,
        scheduled_messages: [
          {
            id: 'Q1234ABCD',
            channel_id: 'C123TEST',
            post_at: Math.floor(Date.now() / 1000) + 3600,
            date_created: Math.floor(Date.now() / 1000),
            text: 'Scheduled hello',
          },
        ],
        response_metadata: { next_cursor: '' },
      }),
    ),
    http.post(`${SLACK_API_BASE}/chat.deleteScheduledMessage`, () =>
      HttpResponse.json({ ok: true }),
    ),
    http.post(`${SLACK_API_BASE}/conversations.open`, () =>
      HttpResponse.json({
        ok: true,
        channel: { id: 'D999TEST', is_im: true },
        already_open: false,
      }),
    ),
    http.post(`${SLACK_API_BASE}/conversations.list`, () =>
      HttpResponse.json({
        ok: true,
        channels: [
          { id: 'C123TEST', name: 'general', is_private: false, num_members: 10 },
        ],
        response_metadata: { next_cursor: '' },
      }),
    ),
    http.post(`${SLACK_API_BASE}/conversations.history`, () =>
      HttpResponse.json({
        ok: true,
        messages: [
          {
            ts: '1704067201.000001',
            user: 'U123',
            text: 'Test message',
          },
        ],
        has_more: false,
        response_metadata: { next_cursor: '' },
      }),
    ),
    http.post(`${SLACK_API_BASE}/conversations.info`, () =>
      HttpResponse.json({
        ok: true,
        channel: {
          id: 'D999TEST',
          is_im: true,
          user: 'U123',
        },
      }),
    ),
    http.post(`${SLACK_API_BASE}/conversations.replies`, () =>
      HttpResponse.json({
        ok: true,
        messages: [
          { ts: '1704067200.123456', user: 'U123', text: 'Parent message' },
          { ts: '1704067210.000001', user: 'U456', text: 'Reply' },
        ],
        has_more: false,
        response_metadata: { next_cursor: '' },
      }),
    ),
    http.post(`${SLACK_API_BASE}/conversations.create`, async ({ request }) => {
      const body = await request.text();
      const params = new URLSearchParams(body);
      const name = params.get('name') || 'new-channel';
      const isPrivate = params.get('is_private') === 'true';
      return HttpResponse.json({
        ok: true,
        channel: { id: 'C999NEW', name, is_private: isPrivate },
      });
    }),
    http.post(`${SLACK_API_BASE}/conversations.mark`, () =>
      HttpResponse.json({ ok: true }),
    ),
    http.post(`${SLACK_API_BASE}/conversations.invite`, () =>
      HttpResponse.json({
        ok: true,
        channel: { id: 'C123TEST', name: 'general' },
      }),
    ),
    http.post(`${SLACK_API_BASE}/users.info`, () =>
      HttpResponse.json({
        ok: true,
        user: {
          id: 'U123',
          name: 'testuser',
          real_name: 'Test User',
          profile: {
            display_name: 'Test',
            email: 'testuser@example.com',
          },
        },
      }),
    ),
    http.post(`${SLACK_API_BASE}/users.list`, () =>
      HttpResponse.json({
        ok: true,
        members: [
          {
            id: 'U123',
            name: 'testuser',
            real_name: 'Test User',
            is_bot: false,
            deleted: false,
            profile: { display_name: 'Test', email: 'testuser@example.com' },
          },
        ],
        response_metadata: { next_cursor: '' },
      }),
    ),
    http.post(`${SLACK_API_BASE}/users.lookupByEmail`, () =>
      HttpResponse.json({
        ok: true,
        user: {
          id: 'U123',
          name: 'testuser',
          real_name: 'Test User',
          profile: { display_name: 'Test', email: 'testuser@example.com' },
        },
      }),
    ),
    http.post(`${SLACK_API_BASE}/search.messages`, () =>
      HttpResponse.json({
        ok: true,
        messages: {
          total: 1,
          paging: { count: 20, total: 1, page: 1, pages: 1 },
          matches: [
            {
              ts: '1704067200.123456',
              channel: { id: 'C123TEST', name: 'general' },
              user: 'U123',
              text: 'Searched message',
              permalink: 'https://test.slack.com/archives/C123TEST/p1704067200123456',
            },
          ],
        },
      }),
    ),
    http.post(`${SLACK_API_BASE}/assistant.search.context`, () =>
      HttpResponse.json({
        ok: true,
        results: {
          messages: [
            {
              author_user_id: 'U123',
              team_id: TEAM_ID,
              channel_id: 'C123TEST',
              channel_name: 'general',
              message_ts: '1704067200.123456',
              content: 'Searched message',
              permalink: 'https://test.slack.com/archives/C123TEST/p1704067200123456',
            },
          ],
        },
        response_metadata: { next_cursor: '' },
      }),
    ),
    http.post(`${SLACK_API_BASE}/reactions.add`, () => HttpResponse.json({ ok: true })),
    http.post(`${SLACK_API_BASE}/bookmarks.add`, async ({ request }) => {
      const body = await request.text();
      const params = new URLSearchParams(body);
      return HttpResponse.json({
        ok: true,
        bookmark: {
          id: 'Bk123',
          channel_id: params.get('channel_id') || 'C123TEST',
          title: params.get('title') || 'Test',
          link: params.get('link') || 'https://example.com',
        },
      });
    }),
    http.post(`${SLACK_API_BASE}/reminders.add`, () =>
      HttpResponse.json({
        ok: true,
        reminder: {
          id: 'Rm123',
          text: 'Test reminder',
          time: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    ),
    http.post(`${SLACK_API_BASE}/files.info`, () =>
      HttpResponse.json({
        ok: true,
        file: {
          id: 'F0123456789',
          name: 'test.txt',
          mimetype: 'text/plain',
          filetype: 'txt',
          size: 12,
          url_private_download: 'https://files.slack.com/files-pri/T123-F0123456789/download/test.txt',
        },
      }),
    ),
    http.get(
      'https://files.slack.com/files-pri/:teamFile/download/:filename',
      () => HttpResponse.text('hello world!', { status: 200 }),
    ),
    http.post(`${SLACK_API_BASE}/oauth.v2.access`, async ({ request }) => {
      const body = await request.text();
      const params = new URLSearchParams(body);
      const grantType = params.get('grant_type');
      if (grantType !== 'refresh_token') {
        return HttpResponse.json({ ok: false, error: 'invalid_grant_type' });
      }
      return HttpResponse.json({
        ok: true,
        access_token: 'xoxb-refreshed-bot-token',
        refresh_token: 'xoxe-1-refreshed',
        expires_in: 43200,
        token_type: 'bot',
      });
    }),
  ];
}
