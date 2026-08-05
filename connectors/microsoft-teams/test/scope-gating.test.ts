import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { createMockApi, type MockApiState } from './fixtures/microsoft-mock-api.js';
import {
  createMicrosoftConfigDir,
  createTestClient,
  type McpTestClient,
  type MicrosoftTestConfig,
} from './fixtures/mcp-test-client.js';

// Tools gated on Graph permissions beyond the cohort base scope set must fail
// with actionable reconnect guidance — not a raw Graph 403 — when the token
// lacks the scope, and must not call Graph at all.
const BASE_SCOPES = 'Chat.Read Chat.ReadWrite Presence.Read offline_access';

describe('scope gating for admin-consent Graph permissions', () => {
  let client: McpTestClient;
  let cfg: MicrosoftTestConfig;
  let state: MockApiState;

  beforeAll(async () => {
    cfg = createMicrosoftConfigDir({ scope: BASE_SCOPES });
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

  it('list_channel_messages reports the missing ChannelMessage.Read.All scope', async () => {
    const result = await client.callTool('list_channel_messages', {
      teamId: 'team-1',
      channelId: 'channel-1',
    });
    expect(result.isError).toBe(true);
    const json = result.json as {
      ok: boolean;
      error: string;
      action_required: string;
      next_step: string;
      missing_scopes: string[];
    };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('ChannelMessage.Read.All');
    expect(json.action_required).toMatch(/administrator/i);
    expect(json.next_step).toBe('authenticate_microsoft_account');
    expect(json.missing_scopes).toEqual(['ChannelMessage.Read.All']);
    const call = state.requests.find((r) => r.pathname.includes('/channels/channel-1/messages'));
    expect(call).toBeUndefined();
  });

  it('send_channel_message reports the missing ChannelMessage.Send scope', async () => {
    const result = await client.callTool('send_channel_message', {
      teamId: 'team-1',
      channelId: 'channel-1',
      content: 'Hello channel',
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; missing_scopes: string[] };
    expect(json.ok).toBe(false);
    expect(json.missing_scopes).toEqual(['ChannelMessage.Send']);
    const call = state.requests.find(
      (r) => r.method === 'POST' && r.pathname.includes('/channels/channel-1/messages'),
    );
    expect(call).toBeUndefined();
  });

  it('reply_to_channel_message reports the missing ChannelMessage.Send scope', async () => {
    const result = await client.callTool('reply_to_channel_message', {
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'channel-msg-1',
      content: 'Agreed',
    });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; missing_scopes: string[] };
    expect(json.ok).toBe(false);
    expect(json.missing_scopes).toEqual(['ChannelMessage.Send']);
  });

  it('find_user reports the missing User.ReadBasic.All scope', async () => {
    const result = await client.callTool('find_user', { query: 'alice@example.com' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; missing_scopes: string[] };
    expect(json.ok).toBe(false);
    expect(json.missing_scopes).toEqual(['User.ReadBasic.All']);
    const call = state.requests.find((r) => r.pathname.includes('/users'));
    expect(call).toBeUndefined();
  });

  it('get_user_presence reports the missing Presence.Read.All scope', async () => {
    const result = await client.callTool('get_user_presence', { userId: 'alice@example.com' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; missing_scopes: string[] };
    expect(json.ok).toBe(false);
    expect(json.missing_scopes).toEqual(['Presence.Read.All']);
    const call = state.requests.find((r) => r.pathname.includes('/presence'));
    expect(call).toBeUndefined();
  });

  it('set_presence reports the missing Presence.ReadWrite scope', async () => {
    const result = await client.callTool('set_presence', { availability: 'Busy' });
    expect(result.isError).toBe(true);
    const json = result.json as { ok: boolean; missing_scopes: string[] };
    expect(json.ok).toBe(false);
    expect(json.missing_scopes).toEqual(['Presence.ReadWrite']);
    const call = state.requests.find((r) => r.pathname.includes('setUserPreferredPresence'));
    expect(call).toBeUndefined();
  });

  it('ungated chat tools still work under the base scope set', async () => {
    const result = await client.callTool('list_chats', { top: 1 });
    expect(result.isError).not.toBe(true);
  });
});
