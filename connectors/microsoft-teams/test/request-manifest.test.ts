import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

interface ManifestRow {
  tool: string;
  method: string;
  pathname: string;
  args: Record<string, unknown>;
}

const MANIFEST: ManifestRow[] = [
  {
    tool: 'list_chats',
    method: 'GET',
    pathname: '/v1.0/me/chats',
    args: { top: 1 },
  },
  {
    tool: 'get_chat',
    method: 'GET',
    pathname: '/v1.0/me/chats/:chatId',
    args: { chatId: 'chat-1' },
  },
  {
    tool: 'list_chat_messages',
    method: 'GET',
    pathname: '/v1.0/me/chats/:chatId/messages',
    args: { chatId: 'chat-1', top: 1 },
  },
  {
    tool: 'send_chat_message',
    method: 'POST',
    pathname: '/v1.0/me/chats/:chatId/messages',
    args: { chatId: 'chat-1', content: 'Hello team' },
  },
  {
    tool: 'reply_to_message',
    method: 'POST',
    pathname: '/v1.0/me/chats/:chatId/messages/:messageId/replies',
    args: { chatId: 'chat-1', messageId: 'msg-1', content: 'On it' },
  },
  {
    tool: 'list_teams',
    method: 'GET',
    pathname: '/v1.0/me/joinedTeams',
    args: {},
  },
  {
    tool: 'list_channels',
    method: 'GET',
    pathname: '/v1.0/teams/:teamId/channels',
    args: { teamId: 'team-1' },
  },
  {
    tool: 'list_channel_messages',
    method: 'GET',
    pathname: '/v1.0/teams/:teamId/channels/:channelId/messages',
    args: { teamId: 'team-1', channelId: 'channel-1', top: 1 },
  },
  {
    tool: 'send_channel_message',
    method: 'POST',
    pathname: '/v1.0/teams/:teamId/channels/:channelId/messages',
    args: { teamId: 'team-1', channelId: 'channel-1', content: 'Hello channel' },
  },
  {
    tool: 'reply_to_channel_message',
    method: 'POST',
    pathname: '/v1.0/teams/:teamId/channels/:channelId/messages/:messageId/replies',
    args: { teamId: 'team-1', channelId: 'channel-1', messageId: 'channel-msg-1', content: 'Agreed' },
  },
  {
    tool: 'find_user',
    method: 'GET',
    pathname: '/v1.0/users/:userId',
    args: { query: 'alice@example.com' },
  },
  {
    tool: 'create_chat',
    method: 'POST',
    pathname: '/v1.0/chats',
    args: { members: ['alice@example.com'] },
  },
  {
    tool: 'search_messages',
    method: 'POST',
    pathname: '/v1.0/search/query',
    args: { query: 'budget' },
  },
  {
    tool: 'get_presence',
    method: 'GET',
    pathname: '/v1.0/me/presence',
    args: {},
  },
];

function matchPath(actual: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[\.+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+') + '$',
  );
  return regex.test(actual);
}

const AUTH_HOST = ['login', 'microsoftonline', 'com'].join('.');
function isAuthEndpoint(url: string): boolean {
  try {
    return new URL(url).hostname === AUTH_HOST;
  } catch {
    return false;
  }
}

describe('request manifest — Graph endpoint contract', () => {
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

  for (const row of MANIFEST) {
    it(`${row.tool} → ${row.method} ${row.pathname}`, async () => {
      await client.callTool(row.tool, row.args);
      const match = state.requests.find(
        (r) =>
          r.method === row.method &&
          matchPath(r.pathname, row.pathname) &&
          !isAuthEndpoint(r.url),
      );
      expect(
        match,
        `${row.tool}: no ${row.method} request matched ${row.pathname} (saw ${state.requests
          .map((r) => `${r.method} ${r.pathname}`)
          .join(', ')})`,
      ).toBeDefined();
    });
  }
});
