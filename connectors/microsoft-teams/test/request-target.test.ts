import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { Client } from '@microsoft/microsoft-graph-client';
import { mswServer } from './fixtures/setup.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

// Every Graph request is recorded by its raw URL (and body) so the tests can
// assert the exact request target, and that a refused argument makes none.
let graphRequests: Array<{ url: string; body: unknown }> = [];

function recordAllGraphRequests(): void {
  mswServer.use(
    http.all('https://graph.microsoft.com/*', async ({ request }) => {
      let body: unknown = null;
      try {
        body = await request.clone().json();
      } catch {
        body = null;
      }
      graphRequests.push({ url: request.url, body });
      return HttpResponse.json({ id: 'chat-1', chatType: 'oneOnOne', value: [] });
    }),
  );
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

interface ErrorEnvelope {
  ok: boolean;
  error: string;
  action_required: string;
  next_step?: string;
}

describe('microsoft-teams request targets', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir();
    client = await createTestClient({
      env: { MS_CLIENT_ID: 'mock-client-id', MS_CONFIG_DIR: cfg.configPath },
    });
  });

  beforeEach(() => {
    graphRequests = [];
    recordAllGraphRequests();
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  async function expectRefused(
    tool: string,
    args: Record<string, unknown>,
    field: string,
    hostileMarker: string,
  ): Promise<void> {
    const result = await client.callTool(tool, args);
    expect(
      graphRequests.map((r) => r.url),
      'raw Graph requests made',
    ).toEqual([]);
    expect(result.isError).toBe(true);
    const json = result.json as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error).toContain(`"${field}"`);
    expect(json.error).not.toContain(hostileMarker);
    expect(json.action_required).not.toMatch(/authenticat/i);
    expect(json.next_step).toBeTruthy();
  }

  describe('hostile IDs are refused before any Graph request', () => {
    it.each([
      ['get_chat', { chatId: '../../users/victim' }, 'chatId', 'victim'],
      ['list_chat_messages', { chatId: 'zzmarker?$top=999' }, 'chatId', 'zzmarker'],
      ['send_chat_message', { chatId: '../../chats/teams-send-chat-marker', content: 'hi' }, 'chatId', 'teams-send-chat-marker'],
      ['list_channels', { teamId: 'zzmarker#x' }, 'teamId', 'zzmarker'],
      ['list_channel_messages', { teamId: 'team-1', channelId: '../teams-channel-marker' }, 'channelId', 'teams-channel-marker'],
      ['send_channel_message', { teamId: '../teams-send-channel-marker', channelId: 'c', content: 'hi' }, 'teamId', 'teams-send-channel-marker'],
      [
        'reply_to_channel_message',
        { teamId: 'team-1', channelId: 'channel-1', messageId: '%2e%2e-teams-message-marker', content: 'hi' },
        'messageId',
        'teams-message-marker',
      ],
      ['reply_to_message', { chatId: 'chat-1', messageId: '../teams-reply-message-marker', content: 'hi' }, 'messageId', 'teams-reply-message-marker'],
      ['get_user_presence', { userId: '../teams-presence-marker' }, 'userId', 'teams-presence-marker'],
      ['get_user_presence', { userId: '../teams-presence-dot-marker' }, 'userId', 'teams-presence-dot-marker'],
      ['find_user', { query: '..@x/../../teams-find-marker' }, 'query', 'teams-find-marker'],
      ['create_chat', { members: ['../teams-member-marker'] }, 'members', 'teams-member-marker'],
    ])('%s %j', async (tool, args, field, hostileMarker) => {
      await expectRefused(tool, args as Record<string, unknown>, field, hostileMarker);
    });
  });

  describe('real Teams IDs still reach the same resource', () => {
    it('get_chat sends a 19:...@thread.v2 chat ID percent-encoded', async () => {
      await client.callTool('get_chat', { chatId: '19:abc123def@thread.v2' });
      const url = graphRequests[0]!.url;
      expect(pathOf(url)).toBe('/v1.0/me/chats/19%3Aabc123def%40thread.v2');
      expect(decodeURIComponent(pathOf(url))).toBe('/v1.0/me/chats/19:abc123def@thread.v2');
    });

    it('list_chat_messages decodes to the same 19:...@unq.gbl.spaces chat', async () => {
      await client.callTool('list_chat_messages', { chatId: '19:a1b2_c3d4@unq.gbl.spaces' });
      expect(decodeURIComponent(pathOf(graphRequests[0]!.url))).toBe(
        '/v1.0/me/chats/19:a1b2_c3d4@unq.gbl.spaces/messages',
      );
    });

    it('list_channel_messages encodes team and channel IDs', async () => {
      await client.callTool('list_channel_messages', {
        teamId: '8f2b3c4d-1111-2222-3333-444455556666',
        channelId: '19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2',
      });
      expect(pathOf(graphRequests[0]!.url)).toBe(
        '/v1.0/teams/8f2b3c4d-1111-2222-3333-444455556666/channels/19%3A4a95f7d8db4c4e7fae857bcebe0623e6%40thread.tacv2/messages',
      );
    });

    it('reply_to_channel_message encodes every segment', async () => {
      await client.callTool('reply_to_channel_message', {
        teamId: 'team-1',
        channelId: '19:chan@thread.tacv2',
        messageId: '1700000000000',
        content: 'On it',
      });
      expect(pathOf(graphRequests[0]!.url)).toBe(
        '/v1.0/teams/team-1/channels/19%3Achan%40thread.tacv2/messages/1700000000000/replies',
      );
    });

    it('get_user_presence keeps working for a guest principal name with #EXT#', async () => {
      await client.callTool('get_user_presence', {
        userId: 'jane_example.com#EXT#@tenant.example',
      });
      expect(pathOf(graphRequests[0]!.url)).toBe(
        '/v1.0/users/jane_example.com%23EXT%23%40tenant.example/presence',
      );
    });

    it('create_chat binds members by encoded user segment', async () => {
      await client.callTool('create_chat', { members: ['jane_example.com#EXT#@tenant.example'] });
      const body = graphRequests[0]!.body as {
        'members@odata.bind': Array<Record<string, string>>;
      };
      expect(body['members@odata.bind'][1]!['user@odata.bind']).toBe(
        'https://graph.microsoft.com/v1.0/users/jane_example.com%23EXT%23%40tenant.example',
      );
    });
  });

  it('find_user sends a name search as one $search value', async () => {
    await client.callTool('find_user', { query: 'Alice&$select=mobilePhone' });
    const params = new URL(graphRequests[0]!.url).searchParams;
    expect(params.get('$search')).toBe('"displayName:Alice&$select=mobilePhone"');
    expect(params.get('$select')?.split(',')).not.toContain('mobilePhone');
  });
});

describe('Graph SDK query building (pinned)', () => {
  beforeEach(() => {
    graphRequests = [];
    recordAllGraphRequests();
  });

  it('does not encode .search() values, so the connector must', async () => {
    const sdk = Client.init({ authProvider: (done) => done(null, 'test-token') });
    await sdk.api('/users').search('"x&$top=9"').get();
    const params = new URL(graphRequests[0]!.url).searchParams;
    expect(params.get('$search')).toBe('"x');
    expect(params.get('$top')).toBe('9"');
  });
});
