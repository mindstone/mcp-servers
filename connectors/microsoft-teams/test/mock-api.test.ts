import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

describe('microsoft-teams mock-API integration', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;
  let state: MockApiState;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: {
        MS_CLIENT_ID: 'mock-client-id',
        MS_CONFIG_DIR: cfg.configPath,
      },
    });
  });

  beforeEach(() => {
    const mock = createMockApi();
    state = mock.state;
    mswServer.use(...mock.handlers);
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('list_chats returns formatted chats and hits /me/chats', async () => {
    const result = await client.callTool('list_chats', { top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      count: number;
      chats: Array<{ id: string; topic: string }>;
    };
    expect(json.count).toBe(2);
    expect(json.chats[0]?.id).toBe('chat-1');
    expect(json.chats[1]?.topic).toBe('(No topic)');
    const call = state.requests.find((r) => r.pathname.endsWith('/me/chats'));
    expect(call).toBeDefined();
    expect(call?.search).toMatch(/\$top=5/);
  });

  it('get_chat returns chat details with members', async () => {
    const result = await client.callTool('get_chat', { chatId: 'chat-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      id: string;
      topic: string;
      members: Array<{ displayName: string; email: string; roles: string[] }>;
    };
    expect(json.id).toBe('chat-1');
    expect(json.topic).toContain('Project Alpha');
    expect(json.members[0]?.displayName).toContain('Alice');
    expect(json.members[0]?.email).toContain('alice@example.com');
    expect(json.members[0]?.roles).toEqual(['owner']);
  });

  it('list_chat_messages returns chat messages with html stripped', async () => {
    const result = await client.callTool('list_chat_messages', { chatId: 'chat-1', top: 2 });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      count: number;
      messages: Array<{ id: string; content: string; from: string }>;
    };
    expect(json.count).toBe(2);
    expect(json.messages[0]?.id).toBe('msg-1');
    expect(json.messages[0]?.content).toContain('Hello & welcome!');
    expect(json.messages[0]?.from).toContain('Alice');
  });

  it('list_teams returns joined teams', async () => {
    const result = await client.callTool('list_teams', {});
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      count: number;
      teams: Array<{ id: string; name: string; description: string }>;
    };
    expect(json.count).toBe(1);
    expect(json.teams[0]?.id).toBe('team-1');
    expect(json.teams[0]?.name).toContain('Engineering');
    expect(json.teams[0]?.description).toContain('Engineering team');
  });

  it('list_channels returns channels for a team', async () => {
    const result = await client.callTool('list_channels', { teamId: 'team-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      teamId: string;
      count: number;
      channels: Array<{ id: string; name: string }>;
    };
    expect(json.teamId).toBe('team-1');
    expect(json.count).toBe(2);
    expect(json.channels[0]?.name).toContain('General');
  });

  it('get_presence returns current presence details', async () => {
    const result = await client.callTool('get_presence', {});
    expect(result.isError).not.toBe(true);
    expect(result.json).toMatchObject({
      availability: 'Available',
      activity: 'Available',
    });
    expect((result.json as { statusMessage?: string }).statusMessage).toContain('Heads down');
  });

  it('send_chat_message sends to chat scope', async () => {
    const result = await client.callTool('send_chat_message', {
      chatId: 'chat-1',
      content: 'Hello team',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { success: boolean; messageId: string };
    expect(json.success).toBe(true);
    expect(json.messageId).toBe('msg-new');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/chats/chat-1/messages'),
    );
    expect(call?.body).toMatchObject({
      body: { contentType: 'text', content: 'Hello team' },
    });
  });

  it('list_channel_messages returns channel messages', async () => {
    const result = await client.callTool('list_channel_messages', {
      teamId: 'team-1',
      channelId: 'channel-1',
      top: 5,
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      teamId: string;
      channelId: string;
      count: number;
      messages: Array<{ id: string; content: string; from: string; replyToId?: string }>;
    };
    expect(json.teamId).toBe('team-1');
    expect(json.channelId).toBe('channel-1');
    expect(json.count).toBe(2);
    expect(json.messages[0]?.content).toContain('Quarterly numbers are in');
    expect(json.messages[0]?.from).toContain('Alice');
    expect(json.messages[1]?.replyToId).toBe('channel-msg-1');
    expect((json as { hasMore?: boolean }).hasMore).toBe(false);
    const call = state.requests.find(
      (r) => r.pathname.endsWith('/teams/team-1/channels/channel-1/messages') && r.method === 'GET',
    );
    expect(call).toBeDefined();
    expect(call?.search).toMatch(/\$top=5/);
  });

  it('send_channel_message posts to the channel messages endpoint', async () => {
    const result = await client.callTool('send_channel_message', {
      teamId: 'team-1',
      channelId: 'channel-1',
      content: 'Hello channel',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { success: boolean; messageId: string };
    expect(json.success).toBe(true);
    expect(json.messageId).toBe('channel-msg-new');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/teams/team-1/channels/channel-1/messages'),
    );
    expect(call?.body).toMatchObject({
      body: { contentType: 'text', content: 'Hello channel' },
    });
  });

  it('reply_to_channel_message posts to the replies endpoint', async () => {
    const result = await client.callTool('reply_to_channel_message', {
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'channel-msg-1',
      content: 'Agreed',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { success: boolean; messageId: string };
    expect(json.success).toBe(true);
    expect(json.messageId).toBe('channel-reply-new');
    const call = state.requests.find(
      (r) =>
        r.method === 'POST' &&
        r.pathname.endsWith('/teams/team-1/channels/channel-1/messages/channel-msg-1/replies'),
    );
    expect(call?.body).toMatchObject({
      body: { contentType: 'text', content: 'Agreed' },
    });
  });

  it('find_user resolves an email address to a user', async () => {
    const result = await client.callTool('find_user', { query: 'alice@example.com' });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      count: number;
      users: Array<{ id: string; displayName: string; email: string }>;
    };
    expect(json.count).toBe(1);
    expect(json.users[0]?.id).toBe('user-1');
    expect(json.users[0]?.displayName).toContain('Alice Anderson');
    const call = state.requests.find((r) => r.method === 'GET' && r.pathname.includes('/users/'));
    expect(call).toBeDefined();
  });

  it('find_user returns an empty result for an unknown email', async () => {
    const result = await client.callTool('find_user', { query: 'missing@example.com' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { count: number; users: unknown[] };
    expect(json.count).toBe(0);
    expect(json.users).toEqual([]);
  });

  it('find_user searches by display name with $search', async () => {
    const result = await client.callTool('find_user', { query: 'Alice' });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      count: number;
      hasMore: boolean;
      users: Array<{ id: string; email: string }>;
    };
    expect(json.count).toBe(2);
    expect(json.hasMore).toBe(false);
    expect(json.users[1]?.email).toContain('aaron@example.com');
    const call = state.requests.find(
      (r) => r.method === 'GET' && r.pathname.endsWith('/v1.0/users'),
    );
    expect(call?.search).toMatch(/\$search=/);
    expect(decodeURIComponent(call?.search ?? '')).toContain('"displayName:Alice"');
  });

  it('create_chat creates a 1:1 chat binding the caller and the member', async () => {
    const result = await client.callTool('create_chat', { members: ['alice@example.com'] });
    expect(result.isError).not.toBe(true);
    const json = result.json as { success: boolean; chatId: string; chatType: string };
    expect(json.success).toBe(true);
    expect(json.chatId).toBe('chat-new');
    expect(json.chatType).toBe('oneOnOne');
    const call = state.requests.find((r) => r.method === 'POST' && r.pathname.endsWith('/v1.0/chats'));
    const body = call?.body as {
      chatType: string;
      topic?: string;
      'members@odata.bind': Array<{ 'user@odata.bind': string }>;
    };
    expect(body.chatType).toBe('oneOnOne');
    expect(body.topic).toBeUndefined();
    expect(body['members@odata.bind']).toHaveLength(2);
    expect(body['members@odata.bind'][0]?.['user@odata.bind']).toBe(
      'https://graph.microsoft.com/v1.0/me',
    );
    expect(body['members@odata.bind'][1]?.['user@odata.bind']).toBe(
      'https://graph.microsoft.com/v1.0/users/alice%40example.com',
    );
  });

  it('create_chat creates a group chat with a topic', async () => {
    const result = await client.callTool('create_chat', {
      members: ['alice@example.com', 'aaron@example.com'],
      topic: 'Launch plan',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { success: boolean; chatType: string };
    expect(json.success).toBe(true);
    expect(json.chatType).toBe('group');
    const call = state.requests.find((r) => r.method === 'POST' && r.pathname.endsWith('/v1.0/chats'));
    const body = call?.body as { chatType: string; topic?: string };
    expect(body.chatType).toBe('group');
    expect(body.topic).toBe('Launch plan');
  });

  it('search_messages posts a chatMessage search query and maps hits', async () => {
    const result = await client.callTool('search_messages', { query: 'budget', top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      query: string;
      count: number;
      total: number;
      results: Array<{ id: string; chatId: string; from: string; summary: string; content: string }>;
    };
    expect(json.query).toBe('budget');
    expect(json.count).toBe(1);
    expect(json.total).toBe(1);
    expect(json.results[0]?.id).toBe('msg-9');
    expect(json.results[0]?.chatId).toBe('chat-1');
    expect(json.results[0]?.from).toContain('Alice');
    expect(json.results[0]?.summary).toContain('budget');
    expect(json.results[0]?.summary).not.toContain('<c0>');
    expect(json.results[0]?.content).toContain('The budget draft is ready');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/search/query'),
    );
    const body = call?.body as {
      requests: Array<{ entityTypes: string[]; query: { queryString: string }; size: number }>;
    };
    expect(body.requests[0]?.entityTypes).toEqual(['chatMessage']);
    expect(body.requests[0]?.query.queryString).toBe('budget');
    expect(body.requests[0]?.size).toBe(5);
  });

  it('reply_to_message posts to the chat message replies endpoint', async () => {
    const result = await client.callTool('reply_to_message', {
      chatId: 'chat-1',
      messageId: 'msg-1',
      content: 'On it',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { success: boolean; messageId: string };
    expect(json.success).toBe(true);
    expect(json.messageId).toBe('reply-new');
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/chats/chat-1/messages/msg-1/replies'),
    );
    expect(call?.body).toMatchObject({
      body: { contentType: 'text', content: 'On it' },
    });
  });

  it('get_user_presence returns a colleague presence', async () => {
    const result = await client.callTool('get_user_presence', { userId: 'alice@example.com' });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      userId: string;
      availability: string;
      activity: string;
      statusMessage: string;
    };
    expect(json.userId).toBe('alice@example.com');
    expect(json.availability).toBe('Busy');
    expect(json.activity).toBe('InAMeeting');
    expect(json.statusMessage).toContain('Focus time');
    const call = state.requests.find(
      (r) => r.method === 'GET' && r.pathname.includes('/users/') && r.pathname.endsWith('/presence'),
    );
    expect(call).toBeDefined();
  });

  it('set_presence posts preferred presence with a duration', async () => {
    const result = await client.callTool('set_presence', {
      availability: 'DoNotDisturb',
      durationMinutes: 60,
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { success: boolean; availability: string; durationMinutes: number };
    expect(json.success).toBe(true);
    expect(json.availability).toBe('DoNotDisturb');
    expect(json.durationMinutes).toBe(60);
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/presence/setUserPreferredPresence'),
    );
    expect(call?.body).toMatchObject({
      availability: 'DoNotDisturb',
      activity: 'DoNotDisturb',
      expirationDuration: 'PT60M',
    });
  });

  it('set_presence without a duration omits expirationDuration', async () => {
    const result = await client.callTool('set_presence', { availability: 'Available' });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/presence/setUserPreferredPresence'),
    );
    const body = call?.body as Record<string, unknown>;
    expect(body.availability).toBe('Available');
    expect('expirationDuration' in body).toBe(false);
  });

  it('list_channel_messages surfaces Graph continuation via hasMore', async () => {
    mswServer.use(
      http.get(
        'https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages',
        () =>
          HttpResponse.json({
            value: [
              {
                id: 'channel-msg-1',
                from: { user: { id: 'user-1', displayName: 'Alice' } },
                body: { content: 'First page', contentType: 'text' },
                createdDateTime: '2026-05-19T08:00:00Z',
              },
            ],
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages?$skip=1',
          }),
      ),
    );

    const result = await client.callTool('list_channel_messages', {
      teamId: 'team-1',
      channelId: 'channel-1',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { count: number; hasMore: boolean };
    expect(json.count).toBe(1);
    expect(json.hasMore).toBe(true);
  });

  it('find_user surfaces truncation via hasMore when Graph returns a next link', async () => {
    mswServer.use(
      http.get('https://graph.microsoft.com/v1.0/users', () =>
        HttpResponse.json({
          value: [
            {
              id: 'user-1',
              displayName: 'Alice Anderson',
              mail: 'alice@example.com',
              userPrincipalName: 'alice@example.com',
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skip=10',
        }),
      ),
    );

    const result = await client.callTool('find_user', { query: 'Alice' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { count: number; hasMore: boolean };
    expect(json.count).toBe(1);
    expect(json.hasMore).toBe(true);
  });

  it('set_presence accepts the 5 and 480 minute boundaries unchanged', async () => {
    for (const [durationMinutes, expected] of [
      [5, 'PT5M'],
      [480, 'PT480M'],
    ] as const) {
      const result = await client.callTool('set_presence', {
        availability: 'Busy',
        durationMinutes,
      });
      expect(result.isError).not.toBe(true);
      const call = state.requests
        .filter((r) => r.method === 'POST' && r.pathname.endsWith('/me/presence/setUserPreferredPresence'))
        .at(-1);
      expect((call?.body as Record<string, unknown>).expirationDuration).toBe(expected);
    }
  });

  it('send_chat_message rejects unknown keys (strict schema)', async () => {
    // F8: the input schema is `.strict()`, so an unexpected argument is refused
    // at the protocol boundary rather than silently forwarded to Graph. The SDK
    // surfaces the schema failure as an isError tool result (-32602).
    const result = await client.client.callTool({
      name: 'send_chat_message',
      arguments: { chatId: 'chat-1', content: 'Hello team', extra: 'not-allowed' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toMatch(/unrecognized key/i);

    // Nothing should have been POSTed to Graph.
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.endsWith('/me/chats/chat-1/messages'),
    );
    expect(call).toBeUndefined();
  });
});
