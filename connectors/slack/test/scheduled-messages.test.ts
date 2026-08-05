/**
 * list_scheduled_slack_messages / delete_scheduled_slack_message — closes the
 * schedule-without-inspect-or-cancel asymmetry: schedule_slack_message existed
 * but scheduled messages could never be listed or cancelled through the
 * connector.
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

describe('Slack MCP — scheduled message list/delete', () => {
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

  it('lists pending scheduled messages with ids and ISO timestamps', async () => {
    const result = await client.callTool('list_scheduled_slack_messages', {});
    const j = result.json as {
      ok?: boolean;
      scheduled_messages?: Array<{
        scheduled_message_id?: string;
        channel?: string;
        post_at?: number;
        post_at_iso?: string;
        text?: string;
      }>;
      count?: number;
    };
    expect(j.ok).toBe(true);
    expect(j.count).toBe(1);
    const m = j.scheduled_messages![0];
    expect(m.scheduled_message_id).toBe('Q1234ABCD');
    expect(m.channel).toBe('C123TEST');
    expect(typeof m.post_at).toBe('number');
    expect(m.post_at_iso).toBe(new Date(m.post_at! * 1000).toISOString());
    // Slack-sourced text is enveloped (invariant #6).
    expect(m.text).toBe(
      '<untrusted-content source="slack:scheduled-message">Scheduled hello</untrusted-content>',
    );
  });

  it('passes the channel filter through to the API', async () => {
    let seenChannel: string | null = null;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.scheduledMessages.list`, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        seenChannel = params.get('channel');
        return HttpResponse.json({ ok: true, scheduled_messages: [] });
      }),
    );
    const result = await client.callTool('list_scheduled_slack_messages', { channel: 'C123TEST' });
    expect((result.json as { ok?: boolean }).ok).toBe(true);
    expect(seenChannel).toBe('C123TEST');
    expect((result.json as { note?: string }).note).toContain('No pending scheduled messages');
  });

  it('surfaces next_cursor for pagination', async () => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.scheduledMessages.list`, () =>
        HttpResponse.json({
          ok: true,
          scheduled_messages: [],
          response_metadata: { next_cursor: 'cursor-page-2' },
        }),
      ),
    );
    const result = await client.callTool('list_scheduled_slack_messages', {});
    const j = result.json as { next_cursor?: string; hint?: string };
    expect(j.next_cursor).toBe('cursor-page-2');
    expect(j.hint).toContain('cursor');
  });

  it('deletes a scheduled message by id', async () => {
    let deleted: { channel: string | null; id: string | null } | null = null;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.deleteScheduledMessage`, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        deleted = { channel: params.get('channel'), id: params.get('scheduled_message_id') };
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await client.callTool('delete_scheduled_slack_message', {
      channel: 'C123TEST',
      scheduled_message_id: 'Q1234ABCD',
    });
    const j = result.json as { ok?: boolean; scheduled_message_id?: string };
    expect(j.ok).toBe(true);
    expect(j.scheduled_message_id).toBe('Q1234ABCD');
    expect(deleted).toEqual({ channel: 'C123TEST', id: 'Q1234ABCD' });
  });

  it('surfaces Slack errors on delete (unknown scheduled message id)', async () => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/chat.deleteScheduledMessage`, () =>
        HttpResponse.json({ ok: false, error: 'invalid_scheduled_message_id' }),
      ),
    );
    const result = await client.callTool('delete_scheduled_slack_message', {
      channel: 'C123TEST',
      scheduled_message_id: 'QDOESNOTEXIST',
    });
    const j = result.json as { ok?: boolean; code?: string };
    expect(j.ok).toBe(false);
    expect(j.code).toBe('invalid_scheduled_message_id');
  });
});
