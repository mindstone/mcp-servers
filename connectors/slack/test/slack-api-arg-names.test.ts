/**
 * Slack-API argument names — the connector accepts the parameter names models
 * actually send (Reliability Engineer's triage, item 2).
 *
 * Sighted payloads that the schemas used to reject or silently strip:
 *   - get_slack_thread_replies   { thread_ts }        instead of { ts }
 *   - search_slack_messages      { max_results }      instead of { count }
 *   - get_slack_channel_history  { oldest, latest }   (native Slack API names)
 *   - search_slack_messages      { after, before }    → after:/before: query modifiers
 *
 * Every assertion here is on the OUTGOING Slack request parameters captured by
 * MSW — a tool that "succeeds" after stripping an unknown key has still lost
 * the caller's requested value, so response-shape checks alone cannot prove
 * the fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
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

interface ToolJson {
  ok?: boolean;
  error?: string;
  action_required?: string;
  messages?: unknown[];
}

/** Capture the form-encoded params of requests to one Slack API method. */
function captureParams(method: string): { seen: () => URLSearchParams | null; count: () => number } {
  let last: URLSearchParams | null = null;
  let calls = 0;
  mswServer.use(
    http.post(`${SLACK_API_BASE}/${method}`, async ({ request }) => {
      calls += 1;
      last = new URLSearchParams(await request.text());
      if (method === 'assistant.search.context') {
        return HttpResponse.json({ ok: true, results: { messages: [] } });
      }
      if (method === 'search.messages') {
        return HttpResponse.json({
          ok: true,
          messages: { total: 0, paging: { count: 20, total: 0, page: 1, pages: 1 }, matches: [] },
        });
      }
      // conversations.replies / conversations.history
      return HttpResponse.json({ ok: true, messages: [], response_metadata: { next_cursor: '' } });
    }),
  );
  return { seen: () => last, count: () => calls };
}

/** Force the legacy search.messages backend by refusing RTS with an installation-scoped code. */
function refuseRealTimeSearch(): void {
  mswServer.use(
    http.post(`${SLACK_API_BASE}/assistant.search.context`, () =>
      HttpResponse.json({ ok: false, error: 'missing_scope' }),
    ),
  );
}

describe('Slack MCP — Slack-API argument names (aliases and time filters)', () => {
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

  beforeEach(async () => {
    mswServer.use(...createSlackHandlers());
    const { _resetSearchBackendCache } = await import('../src/tools/messages.js');
    _resetSearchBackendCache();
    vi.stubEnv('SLACK_TEAM_ID', 'T123');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
  });

  // -------------------------------------------------------------------
  // get_slack_thread_replies — thread_ts alias for ts
  // -------------------------------------------------------------------

  it('thread replies: accepts thread_ts and forwards it as ts to conversations.replies', async () => {
    const replies = captureParams('conversations.replies');
    const result = await client.callTool('get_slack_thread_replies', {
      channel: 'C123TEST',
      thread_ts: '1704067200.123456',
    });
    const j = result.json as ToolJson;
    expect(j.ok).toBe(true);
    expect(replies.seen()?.get('ts')).toBe('1704067200.123456');
  });

  it('thread replies: canonical ts still works', async () => {
    const replies = captureParams('conversations.replies');
    const result = await client.callTool('get_slack_thread_replies', {
      channel: 'C123TEST',
      ts: '1704067200.123456',
    });
    const j = result.json as ToolJson;
    expect(j.ok).toBe(true);
    expect(replies.seen()?.get('ts')).toBe('1704067200.123456');
  });

  it('thread replies: canonical ts wins when both ts and thread_ts are supplied', async () => {
    const replies = captureParams('conversations.replies');
    const result = await client.callTool('get_slack_thread_replies', {
      channel: 'C123TEST',
      ts: '1704067200.123456',
      thread_ts: '1704067299.999999',
    });
    const j = result.json as ToolJson;
    expect(j.ok).toBe(true);
    expect(replies.seen()?.get('ts')).toBe('1704067200.123456');
  });

  it('thread replies: rejects when neither ts nor thread_ts is supplied (no Slack call)', async () => {
    const replies = captureParams('conversations.replies');
    const result = await client.callTool('get_slack_thread_replies', {
      channel: 'C123TEST',
    });
    const j = result.json as ToolJson;
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/parent message timestamp/i);
    expect(j.action_required).toMatch(/thread_ts|ts/i);
    expect(replies.count()).toBe(0);
  });

  // -------------------------------------------------------------------
  // get_slack_channel_history — native oldest / latest bounds
  // -------------------------------------------------------------------

  it('channel history: forwards oldest and latest to conversations.history', async () => {
    const history = captureParams('conversations.history');
    const result = await client.callTool('get_slack_channel_history', {
      channel: 'C123TEST',
      oldest: '1704067200.000000',
      latest: '1704153600.000000',
    });
    const j = result.json as ToolJson;
    expect(j.ok).toBe(true);
    expect(history.seen()?.get('oldest')).toBe('1704067200.000000');
    expect(history.seen()?.get('latest')).toBe('1704153600.000000');
  });

  it('channel history: omits oldest/latest from the request when not supplied', async () => {
    const history = captureParams('conversations.history');
    const result = await client.callTool('get_slack_channel_history', {
      channel: 'C123TEST',
    });
    const j = result.json as ToolJson;
    expect(j.ok).toBe(true);
    expect(history.seen()?.has('oldest')).toBe(false);
    expect(history.seen()?.has('latest')).toBe(false);
  });

  // -------------------------------------------------------------------
  // search_slack_messages — max_results alias and after/before modifiers
  // -------------------------------------------------------------------

  it('search: max_results sets the Real-Time Search limit (≤20)', async () => {
    const rts = captureParams('assistant.search.context');
    const result = await client.callTool('search_slack_messages', {
      query: 'forecast',
      max_results: 7,
    });
    const j = result.json as ToolJson;
    expect(j.ok).toBe(true);
    expect(rts.seen()?.get('limit')).toBe('7');
  });

  it('search: canonical count still works and wins over max_results when both are supplied', async () => {
    const rts = captureParams('assistant.search.context');
    const canonicalOnly = await client.callTool('search_slack_messages', {
      query: 'forecast',
      count: 5,
    });
    expect((canonicalOnly.json as ToolJson).ok).toBe(true);
    expect(rts.seen()?.get('limit')).toBe('5');

    const both = await client.callTool('search_slack_messages', {
      query: 'forecast',
      count: 5,
      max_results: 12,
    });
    expect((both.json as ToolJson).ok).toBe(true);
    expect(rts.seen()?.get('limit')).toBe('5');
  });

  it('search: max_results maps to count on the legacy search.messages backend', async () => {
    refuseRealTimeSearch();
    const legacy = captureParams('search.messages');
    const result = await client.callTool('search_slack_messages', {
      query: 'forecast',
      max_results: 7,
    });
    const j = result.json as ToolJson & { search_backend?: string };
    expect(j.ok).toBe(true);
    expect(j.search_backend).toBe('search.messages');
    expect(legacy.seen()?.get('count')).toBe('7');
  });

  it('search: after/before become after:/before: query modifiers on Real-Time Search', async () => {
    const rts = captureParams('assistant.search.context');
    const result = await client.callTool('search_slack_messages', {
      query: 'forecast',
      after: '2026-09-20',
      before: '2026-09-27',
    });
    const j = result.json as ToolJson;
    expect(j.ok).toBe(true);
    const query = rts.seen()?.get('query') ?? '';
    expect(query).toContain('after:2026-09-20');
    expect(query).toContain('before:2026-09-27');
    expect(query).toContain('forecast');
  });

  it('search: after/before modifiers reach the legacy search.messages query too', async () => {
    refuseRealTimeSearch();
    const legacy = captureParams('search.messages');
    const result = await client.callTool('search_slack_messages', {
      query: 'forecast',
      after: '2026-09-20',
      before: '2026-09-27',
    });
    const j = result.json as ToolJson & { search_backend?: string };
    expect(j.ok).toBe(true);
    expect(j.search_backend).toBe('search.messages');
    const query = legacy.seen()?.get('query') ?? '';
    expect(query).toContain('after:2026-09-20');
    expect(query).toContain('before:2026-09-27');
  });
});
