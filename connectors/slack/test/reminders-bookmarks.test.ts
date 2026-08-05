/**
 * list_slack_reminders / complete_slack_reminder / delete_slack_reminder /
 * list_slack_bookmarks — closes the add-only asymmetry on reminders and
 * bookmarks (add_slack_reminder / add_slack_bookmark already existed).
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

describe('Slack MCP — reminders & bookmarks lists', () => {
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

  it('lists reminders with enveloped text and ISO time', async () => {
    const result = await client.callTool('list_slack_reminders', {});
    const j = result.json as {
      ok?: boolean;
      count?: number;
      reminders?: Array<{ id?: string; text?: string; time?: number; time_iso?: string }>;
      warning?: string;
    };
    expect(j.ok).toBe(true);
    expect(j.count).toBe(1);
    const r = j.reminders![0];
    expect(r.id).toBe('Rm123');
    expect(r.text).toBe(
      '<untrusted-content source="slack:reminders-list">Test reminder</untrusted-content>',
    );
    expect(r.time_iso).toBe(new Date(r.time! * 1000).toISOString());
    // The experimental-API warning survives on the read path too.
    expect(j.warning).toContain('EXPERIMENTAL');
  });

  it('completes a reminder by id', async () => {
    let seenId: string | null = null;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/reminders.complete`, async ({ request }) => {
        seenId = new URLSearchParams(await request.text()).get('reminder');
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await client.callTool('complete_slack_reminder', { reminder_id: 'Rm123' });
    expect((result.json as { ok?: boolean }).ok).toBe(true);
    expect(seenId).toBe('Rm123');
  });

  it('deletes a reminder by id', async () => {
    let seenId: string | null = null;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/reminders.delete`, async ({ request }) => {
        seenId = new URLSearchParams(await request.text()).get('reminder');
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await client.callTool('delete_slack_reminder', { reminder_id: 'Rm123' });
    expect((result.json as { ok?: boolean }).ok).toBe(true);
    expect(seenId).toBe('Rm123');
  });

  it('surfaces Slack errors on reminder delete (not_found)', async () => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/reminders.delete`, () =>
        HttpResponse.json({ ok: false, error: 'not_found' }),
      ),
    );
    const result = await client.callTool('delete_slack_reminder', { reminder_id: 'RmGONE' });
    const j = result.json as { ok?: boolean; code?: string };
    expect(j.ok).toBe(false);
    expect(j.code).toBe('not_found');
  });

  it('lists channel bookmarks with enveloped titles', async () => {
    const result = await client.callTool('list_slack_bookmarks', { channel: 'C123TEST' });
    const j = result.json as {
      ok?: boolean;
      count?: number;
      bookmarks?: Array<{ id?: string; title?: string; link?: string; emoji?: string }>;
    };
    expect(j.ok).toBe(true);
    expect(j.count).toBe(1);
    const b = j.bookmarks![0];
    expect(b.id).toBe('Bk123');
    expect(b.title).toBe(
      '<untrusted-content source="slack:bookmarks-list">Project dashboard</untrusted-content>',
    );
    expect(b.link).toBe('https://example.com/dashboard');
  });
});
