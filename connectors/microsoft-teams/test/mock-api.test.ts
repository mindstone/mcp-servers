import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

  it('list_messages returns chat messages with html stripped', async () => {
    const result = await client.callTool('list_messages', { chatId: 'chat-1', top: 2 });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      count: number;
      messages: Array<{ id: string; content: string; from: string }>;
    };
    expect(json.count).toBe(2);
    expect(json.messages[0]?.id).toBe('msg-1');
    expect(json.messages[0]?.content).toBe('Hello & welcome!');
    expect(json.messages[0]?.from).toBe('Alice');
  });

  it('list_messages supports channel scope with teamId + channelId', async () => {
    const result = await client.callTool('list_messages', {
      teamId: 'team-1',
      channelId: 'channel-1',
      top: 1,
    });
    expect(result.isError).not.toBe(true);
    const call = state.requests.find((r) =>
      r.pathname.includes('/teams/team-1/channels/channel-1/messages'),
    );
    expect(call).toBeDefined();
  });

  it('list_messages rejects missing message scope guidance', async () => {
    const result = await client.callTool('list_messages', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Provide either "chatId"');
    expect(json.next_step).toBe('list_messages');
  });

  it('search_messages returns stripped summaries', async () => {
    const result = await client.callTool('search_messages', { query: 'project', top: 5 });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      query: string;
      count: number;
      messages: Array<{ id: string; summary: string }>;
    };
    expect(json.query).toBe('project');
    expect(json.count).toBe(1);
    expect(json.messages[0]?.id).toBe('search-1');
    expect(json.messages[0]?.summary).toBe('Matched project update');
  });

  it('search_messages rejects missing query with guidance', async () => {
    const result = await client.callTool('search_messages', {});
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameter: "query"');
    expect(json.next_step).toBe('search_messages');
  });

  it('get_message returns a single message', async () => {
    const result = await client.callTool('get_message', { chatId: 'chat-1', messageId: 'msg-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as { id: string; from: string; content: string };
    expect(json.id).toBe('msg-1');
    expect(json.from).toBe('Alice');
    expect(json.content).toBe('Detailed message');
  });

  it('get_message rejects missing messageId with guidance', async () => {
    const result = await client.callTool('get_message', { chatId: 'chat-1' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; error: string; next_step: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Missing required parameter: "messageId"');
    expect(json.next_step).toBe('get_message');
  });

  it('list_team_channels with teamId returns channel list', async () => {
    const result = await client.callTool('list_team_channels', { teamId: 'team-1' });
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      teamId: string;
      count: number;
      channels: Array<{ id: string; name: string }>;
    };
    expect(json.teamId).toBe('team-1');
    expect(json.count).toBe(2);
    expect(json.channels[0]?.name).toBe('General');
  });

  it('list_team_channels without teamId lists joined teams and channels', async () => {
    const result = await client.callTool('list_team_channels', {});
    expect(result.isError).not.toBe(true);
    const json = result.json as {
      count: number;
      teams: Array<{ id: string; channelCount: number }>;
    };
    expect(json.count).toBe(2);
    expect(json.teams[0]?.id).toBe('team-1');
    expect(json.teams[0]?.channelCount).toBe(2);
  });

  it('send_message sends to chat scope', async () => {
    const result = await client.callTool('send_message', { chatId: 'chat-1', content: 'Hello team' });
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

  it('reply_message replies to a chat message', async () => {
    const result = await client.callTool('reply_message', {
      chatId: 'chat-1',
      messageId: 'msg-1',
      content: 'Thanks!',
    });
    expect(result.isError).not.toBe(true);
    const json = result.json as { success: boolean; messageId: string };
    expect(json.success).toBe(true);
    expect(json.messageId).toBe('reply-new');
    const call = state.requests.find(
      (r) =>
        r.method === 'POST' &&
        r.pathname.endsWith('/me/chats/chat-1/messages/msg-1/replies'),
    );
    expect(call).toBeDefined();
  });

  it('send_message and reply_message reject missing content', async () => {
    const send = await client.callTool('send_message', { chatId: 'chat-1' });
    expect(send.isError).toBe(true);
    expect((send.json as { next_step: string }).next_step).toBe('send_message');

    const reply = await client.callTool('reply_message', {
      chatId: 'chat-1',
      messageId: 'msg-1',
    });
    expect(reply.isError).toBe(true);
    expect((reply.json as { next_step: string }).next_step).toBe('reply_message');
  });
});
