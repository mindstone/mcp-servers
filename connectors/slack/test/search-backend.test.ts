/**
 * Search backend selection — Real-Time Search API with loud legacy fallback.
 *
 * Slack's Real-Time Search API (`assistant.search.context`) superseded legacy
 * `search.messages`, but requires the granular `search:read.*` OAuth scopes
 * that a host-granted token may not have. The connector probes RTS first and,
 * on a scope/feature refusal, falls back to legacy `search.messages` — loudly:
 * every response carries `search_backend`, legacy responses add
 * `search_backend_note`, and the refusal is cached per workspace so the probe
 * cost is paid once per process.
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

interface SearchResponseJson {
  ok?: boolean;
  messages?: Array<{
    ts_slack?: string;
    channel?: { id?: string; name?: string };
    user?: string;
    text?: string;
    permalink?: string;
  }>;
  search_backend?: string;
  search_backend_note?: string;
  error?: string;
  code?: string;
}

describe('Slack MCP — search backend selection', () => {
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

  it('prefers assistant.search.context and maps RTS results into the legacy response shape', async () => {
    const result = await client.callTool('search_slack_messages', { query: 'forecast' });
    const j = result.json as SearchResponseJson;
    expect(j.ok).toBe(true);
    expect(j.search_backend).toBe('assistant.search.context');
    expect(j.search_backend_note).toBeUndefined();
    expect(j.messages).toHaveLength(1);
    const m = j.messages![0];
    expect(m.ts_slack).toBe('1704067200.123456');
    expect(m.channel).toEqual({ id: 'C123TEST', name: 'general' });
    expect(m.user).toBe('U123');
    // External text is enveloped (AGENTS.md invariant #6).
    expect(m.text).toBe(
      '<untrusted-content source="slack:search-messages">Searched message</untrusted-content>',
    );
    expect(m.permalink).toBe('https://test.slack.com/archives/C123TEST/p1704067200123456');
  });

  it('sends the full channel-type set to RTS so private/DM scopes are exercised', async () => {
    let seenChannelTypes: string | null = null;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/assistant.search.context`, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        seenChannelTypes = params.get('channel_types');
        return HttpResponse.json({ ok: true, results: { messages: [] } });
      }),
    );
    await client.callTool('search_slack_messages', { query: 'anything' });
    expect(seenChannelTypes).toBe('public_channel,private_channel,mpim,im');
  });

  it('falls back loudly to legacy search.messages on missing_scope and caches the decision', async () => {
    let rtsCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/assistant.search.context`, () => {
        rtsCalls += 1;
        return HttpResponse.json({ ok: false, error: 'missing_scope' });
      }),
    );

    const first = (await client.callTool('search_slack_messages', { query: 'forecast' }))
      .json as SearchResponseJson;
    expect(first.ok).toBe(true);
    expect(first.search_backend).toBe('search.messages');
    expect(first.search_backend_note).toContain('missing_scope');
    expect(first.search_backend_note).toContain('search:read');
    // Results come from the legacy mock (total/matches shape).
    expect(first.messages).toHaveLength(1);
    expect(first.messages![0].text).toBe(
      '<untrusted-content source="slack:search-messages">Searched message</untrusted-content>',
    );

    const second = (await client.callTool('search_slack_messages', { query: 'forecast' }))
      .json as SearchResponseJson;
    expect(second.search_backend).toBe('search.messages');
    expect(second.search_backend_note).toBeTruthy();
    // The scope refusal is cached — no second RTS probe this process.
    expect(rtsCalls).toBe(1);
  });

  it('does not fall back on transient RTS errors — the error surfaces and RTS is retried next call', async () => {
    let rtsCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/assistant.search.context`, () => {
        rtsCalls += 1;
        return HttpResponse.json({ ok: false, error: 'internal_error' });
      }),
    );

    const first = (await client.callTool('search_slack_messages', { query: 'forecast' }))
      .json as SearchResponseJson;
    expect(first.ok).toBe(false);
    expect(first.code).toBe('internal_error');

    await client.callTool('search_slack_messages', { query: 'forecast' });
    expect(rtsCalls).toBe(2);
  });

  // Every code in the permanently cached fallback set must be installation-
  // or workspace-scoped (see RTS_FALLBACK_ERROR_CODES in messages.ts).
  const INSTALLATION_SCOPED_RTS_REFUSALS = [
    'missing_scope',
    'not_allowed_token_type',
    'feature_not_enabled',
    'deprecated_endpoint',
    'method_deprecated',
  ];

  for (const code of INSTALLATION_SCOPED_RTS_REFUSALS) {
    it(`falls back loudly to legacy search.messages on ${code} and caches the decision`, async () => {
      let rtsCalls = 0;
      mswServer.use(
        http.post(`${SLACK_API_BASE}/assistant.search.context`, () => {
          rtsCalls += 1;
          return HttpResponse.json({ ok: false, error: code });
        }),
      );

      const first = (await client.callTool('search_slack_messages', { query: 'forecast' }))
        .json as SearchResponseJson;
      expect(first.ok).toBe(true);
      expect(first.search_backend).toBe('search.messages');
      expect(first.search_backend_note).toContain(code);

      await client.callTool('search_slack_messages', { query: 'forecast' });
      expect(rtsCalls).toBe(1);
    });
  }

  it('does NOT fall back on access_denied — it may be resource-specific, so it must not poison backend selection', async () => {
    let rtsCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/assistant.search.context`, () => {
        rtsCalls += 1;
        return HttpResponse.json({ ok: false, error: 'access_denied' });
      }),
    );

    const first = (await client.callTool('search_slack_messages', { query: 'forecast' }))
      .json as SearchResponseJson;
    expect(first.ok).toBe(false);
    expect(first.code).toBe('access_denied');
    expect(first.search_backend).toBeUndefined();

    // No caching: the next call probes RTS again rather than being pinned to
    // legacy by one denied query.
    await client.callTool('search_slack_messages', { query: 'forecast' });
    expect(rtsCalls).toBe(2);
  });

  it('caches the fallback per workspace key — a different SLACK_TEAM_ID (or none) re-probes RTS', async () => {
    let rtsCalls = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/assistant.search.context`, () => {
        rtsCalls += 1;
        return HttpResponse.json({ ok: false, error: 'missing_scope' });
      }),
    );

    // Team T1: refusal cached under the T1 key.
    vi.stubEnv('SLACK_TEAM_ID', 'T1');
    await client.callTool('search_slack_messages', { query: 'forecast' });
    await client.callTool('search_slack_messages', { query: 'forecast' });
    expect(rtsCalls).toBe(1);

    // Team T2: separate cache key — RTS is probed again, and T2's refusal
    // must not disturb T1's cached decision.
    vi.stubEnv('SLACK_TEAM_ID', 'T2');
    await client.callTool('search_slack_messages', { query: 'forecast' });
    expect(rtsCalls).toBe(2);

    // No team id: the default key is independent of both.
    vi.stubEnv('SLACK_TEAM_ID', undefined);
    await client.callTool('search_slack_messages', { query: 'forecast' });
    expect(rtsCalls).toBe(3);

    // T1's cached decision is intact — no re-probe for T1.
    vi.stubEnv('SLACK_TEAM_ID', 'T1');
    const again = (await client.callTool('search_slack_messages', { query: 'forecast' }))
      .json as SearchResponseJson;
    expect(again.search_backend).toBe('search.messages');
    expect(rtsCalls).toBe(3);
  });

  it('get_slack_saved_messages routes through the same backend with the is:saved modifier', async () => {
    let seenQuery: string | null = null;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/assistant.search.context`, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        seenQuery = params.get('query');
        return HttpResponse.json({ ok: true, results: { messages: [] } });
      }),
    );
    const result = await client.callTool('get_slack_saved_messages', { query: 'roadmap' });
    const j = result.json as SearchResponseJson;
    expect(j.ok).toBe(true);
    expect(j.search_backend).toBe('assistant.search.context');
    expect(seenQuery).toBe('is:saved roadmap');
  });
});
