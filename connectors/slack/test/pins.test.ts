/**
 * list_slack_pins / pin_slack_message / unpin_slack_message — pinned-items
 * read plus pin/unpin writes (pins.list / pins.add / pins.remove).
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

describe('Slack MCP — pins', () => {
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

  it('lists pinned messages with enveloped text', async () => {
    const result = await client.callTool('list_slack_pins', { channel: 'C123TEST' });
    const j = result.json as {
      ok?: boolean;
      count?: number;
      pins?: Array<{
        type?: string;
        ts_slack?: string;
        ts_iso?: string;
        user?: string;
        text?: string;
        permalink?: string;
      }>;
    };
    expect(j.ok).toBe(true);
    expect(j.count).toBe(1);
    const pin = j.pins![0];
    expect(pin.type).toBe('message');
    expect(pin.ts_slack).toBe(TS);
    expect(pin.ts_iso).toBe('2024-01-01T00:00:00.123Z');
    expect(pin.text).toBe(
      '<untrusted-content source="slack:pins-list">Pinned announcement</untrusted-content>',
    );
    expect(pin.permalink).toBe('https://test.slack.com/archives/C123TEST/p1704067200123456');
  });

  it('reports an empty pin list', async () => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/pins.list`, () => HttpResponse.json({ ok: true, items: [] })),
    );
    const result = await client.callTool('list_slack_pins', { channel: 'C123TEST' });
    const j = result.json as { ok?: boolean; count?: number; note?: string };
    expect(j.ok).toBe(true);
    expect(j.count).toBe(0);
    expect(j.note).toContain('No pinned messages');
  });

  it('pins a message by timestamp', async () => {
    let seen: { channel: string | null; timestamp: string | null } | null = null;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/pins.add`, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        seen = { channel: params.get('channel'), timestamp: params.get('timestamp') };
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await client.callTool('pin_slack_message', { channel: 'C123TEST', timestamp: TS });
    expect((result.json as { ok?: boolean }).ok).toBe(true);
    expect(seen).toEqual({ channel: 'C123TEST', timestamp: TS });
  });

  it('unpins a message by timestamp', async () => {
    let seen: { channel: string | null; timestamp: string | null } | null = null;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/pins.remove`, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        seen = { channel: params.get('channel'), timestamp: params.get('timestamp') };
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await client.callTool('unpin_slack_message', { channel: 'C123TEST', timestamp: TS });
    expect((result.json as { ok?: boolean }).ok).toBe(true);
    expect(seen).toEqual({ channel: 'C123TEST', timestamp: TS });
  });

  it('surfaces Slack errors (already_pinned / not_pinned) instead of pretending success', async () => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/pins.add`, () =>
        HttpResponse.json({ ok: false, error: 'already_pinned' }),
      ),
      http.post(`${SLACK_API_BASE}/pins.remove`, () =>
        HttpResponse.json({ ok: false, error: 'not_pinned' }),
      ),
    );
    const pin = (await client.callTool('pin_slack_message', { channel: 'C123TEST', timestamp: TS }))
      .json as { ok?: boolean; code?: string };
    expect(pin.ok).toBe(false);
    expect(pin.code).toBe('already_pinned');

    const unpin = (
      await client.callTool('unpin_slack_message', { channel: 'C123TEST', timestamp: TS })
    ).json as { ok?: boolean; code?: string };
    expect(unpin.ok).toBe(false);
    expect(unpin.code).toBe('not_pinned');
  });
});
