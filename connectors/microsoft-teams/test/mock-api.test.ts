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
