/**
 * update_slack_message / delete_slack_message — chat.update and chat.delete
 * for messages the connected user posted.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { createSlackHandlers, SLACK_API_BASE } from './fixtures/slack-mock-api.js';
import {
  createTestClient,
  createSlackConfigDir,
  type McpTestClient,
  type SlackTestConfig,
} from './fixtures/mcp-test-client.js';

const CLIENT_ENV = {
  SLACK_CLIENT_ID: 'mock-client-id',
  SLACK_CLIENT_SECRET: 'mock-client-secret',
  SLACK_TEAM_ID: 'T123',
};

const TS = '1704067200.123456';

describe('Slack MCP — update/delete message', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeAll(async () => {
    cfg = createSlackConfigDir({
      tokens: { botToken: 'xoxb-mock', userToken: 'xoxp-mock', botUserId: 'U999BOT' },
    });
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });
  });

  beforeEach(() => {
    mswServer.use(...createSlackHandlers());
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('updates a message and returns the edited ts', async () => {
    let seen: { channel: string | null; ts: string | null; text: string | null } | null = null;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.update`, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        seen = {
          channel: params.get('channel'),
          ts: params.get('ts'),
          text: params.get('text'),
        };
        return HttpResponse.json({ ok: true, channel: seen.channel, ts: seen.ts });
      }),
    );
    const result = await client.callTool('update_slack_message', {
      channel: 'C123TEST',
      ts: TS,
      text: 'edited text',
    });
    const j = result.json as { ok?: boolean; ts_slack?: string; ts_iso?: string };
    expect(j.ok).toBe(true);
    expect(j.ts_slack).toBe(TS);
    expect(j.ts_iso).toBe('2024-01-01T00:00:00.123Z');
    expect(seen).toEqual({ channel: 'C123TEST', ts: TS, text: 'edited text' });
  });

  it('deletes a message by ts', async () => {
    let seen: { channel: string | null; ts: string | null } | null = null;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.delete`, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        seen = { channel: params.get('channel'), ts: params.get('ts') };
        return HttpResponse.json({ ok: true, channel: seen.channel, ts: seen.ts });
      }),
    );
    const result = await client.callTool('delete_slack_message', { channel: 'C123TEST', ts: TS });
    const j = result.json as { ok?: boolean; ts_slack?: string; note?: string };
    expect(j.ok).toBe(true);
    expect(j.ts_slack).toBe(TS);
    expect(seen).toEqual({ channel: 'C123TEST', ts: TS });
  });

  it('surfaces Slack errors (message_not_found / cant_update_message) instead of pretending success', async () => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.update`, () =>
        HttpResponse.json({ ok: false, error: 'cant_update_message' }),
      ),
      http.post(`${SLACK_API_BASE}/chat.delete`, () =>
        HttpResponse.json({ ok: false, error: 'message_not_found' }),
      ),
    );
    const update = (await client.callTool('update_slack_message', {
      channel: 'C123TEST',
      ts: TS,
      text: 'x',
    })).json as { ok?: boolean; code?: string };
    expect(update.ok).toBe(false);
    expect(update.code).toBe('cant_update_message');

    const del = (await client.callTool('delete_slack_message', { channel: 'C123TEST', ts: TS }))
      .json as { ok?: boolean; code?: string };
    expect(del.ok).toBe(false);
    expect(del.code).toBe('message_not_found');
  });
});

describe('Slack MCP — update/delete message without tokens', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeAll(async () => {
    cfg = createSlackConfigDir(); // no token files
    client = await createTestClient({
      env: { ...CLIENT_ENV, SLACK_CONFIG_PATH: cfg.configPath },
    });
  });

  beforeEach(() => {
    mswServer.use(...createSlackHandlers());
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  it('returns reconnect guidance when no user token is configured', async () => {
    const result = await client.callTool('delete_slack_message', { channel: 'C123TEST', ts: TS });
    const j = result.json as { ok?: boolean; next_step?: string };
    expect(j.ok).toBe(false);
    expect(j.next_step).toBe('authenticate_slack_workspace');
  });
});
