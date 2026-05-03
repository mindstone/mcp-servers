import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { http, HttpResponse } from 'msw';
import { createSlackHandlers, SLACK_API_BASE } from './fixtures/slack-mock-api.js';
import { Stage0AuthRequiredSchema } from './fixtures/stage0-auth-schema.js';
import {
  createTestClient,
  createSlackConfigDir,
  type McpTestClient,
  type SlackTestConfig,
} from './fixtures/mcp-test-client.js';

describe('SLACK_DISABLE_REFRESH=1 — fail-closed with auth_required', () => {
  let client: McpTestClient;
  let cfg: SlackTestConfig;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    if (client) await client.close();
    if (cfg) cfg.cleanup();
    vi.unstubAllEnvs();
  });

  it('tokenProvider throws TOKEN_EXPIRED_REFRESH_DISABLED on expiry instead of refreshing', async () => {
    let oauthCalled = false;
    // Register the spying handler FIRST — last-added does NOT win in MSW.
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, () => {
        oauthCalled = true;
        return HttpResponse.json({ ok: true, access_token: 'xoxb-rotated', expires_in: 43200 });
      }),
      ...createSlackHandlers(),
    );

    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock-bot-expired',
        userToken: 'xoxp-mock-user-expired',
        botUserId: 'U999BOT',
        botRefreshToken: 'xoxe-1-bot-refresh',
        botExpiresAt: Date.now() - 60_000, // already expired
        userRefreshToken: 'xoxe-1-user-refresh',
        userExpiresAt: Date.now() - 60_000,
      },
    });

    vi.stubEnv('SLACK_DISABLE_REFRESH', '1');
    vi.stubEnv('SLACK_CONFIG_PATH', cfg.configPath);
    vi.stubEnv('SLACK_TEAM_ID', 'T123');
    vi.stubEnv('SLACK_CLIENT_ID', 'mock-client-id');
    vi.stubEnv('SLACK_CLIENT_SECRET', 'mock-client-secret');

    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(cfg.configPath, 'T123', 'mock-client-id', 'mock-client-secret');

    await expect(tp.getBotToken()).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED_REFRESH_DISABLED',
    });
    expect(oauthCalled).toBe(false);
  });

  it('tool response is auth_required structured shape on expired bot token AND no oauth.v2.access call is made', async () => {
    let oauthCalled = false;
    // Spy handler registered FIRST so MSW prefers it over the default.
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, () => {
        oauthCalled = true;
        return HttpResponse.json({ ok: true, access_token: 'xoxb-rotated', expires_in: 43200 });
      }),
      ...createSlackHandlers(),
    );

    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock-bot',
        userToken: 'xoxp-mock-user',
        botUserId: 'U999BOT',
        botRefreshToken: 'xoxe-1-bot-refresh',
        botExpiresAt: Date.now() - 60_000,
      },
    });

    client = await createTestClient({
      env: {
        SLACK_DISABLE_REFRESH: '1',
        SLACK_CONFIG_PATH: cfg.configPath,
        SLACK_TEAM_ID: 'T123',
        SLACK_CLIENT_ID: 'mock-client-id',
        SLACK_CLIENT_SECRET: 'mock-client-secret',
      },
    });

    // get_slack_user_profile uses bot client → expired → should emit auth_required
    const result = await client.callTool('get_slack_user_profile', { user: 'U123' });
    const j = result.json as Record<string, unknown>;
    expect(j.status).toBe('auth_required');
    expect(j.user_action).toMatchObject({
      id: 'slack.connect_workspace',
    });
    expect(j.agent_action).toMatchObject({
      instruction: expect.stringContaining('Connect Slack'),
    });
    expect(j.setupToolName).toBe('authenticate_slack_workspace');
    // Structural Stage 0 schema check — same contract the host applies.
    const parsed = Stage0AuthRequiredSchema.safeParse(j);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
    // Tool-level invariant: SLACK_DISABLE_REFRESH=1 must short-circuit BEFORE
    // any HTTP refresh call. If a future PR breaks the disable-refresh wiring
    // by, say, refreshing-then-emitting-auth_required, this assertion catches it.
    expect(oauthCalled).toBe(false);
  });

  it('with SLACK_DISABLE_REFRESH unset, refresh runs as normal', async () => {
    let oauthCalled = false;
    // Register our override FIRST so MSW prefers it over the default handler.
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, async ({ request }) => {
        oauthCalled = true;
        const body = await request.text();
        const params = new URLSearchParams(body);
        expect(params.get('grant_type')).toBe('refresh_token');
        return HttpResponse.json({
          ok: true,
          access_token: 'xoxb-rotated',
          refresh_token: 'xoxe-1-rotated',
          expires_in: 43200,
        });
      }),
      ...createSlackHandlers(),
    );

    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-mock-bot-old',
        userToken: 'xoxp-mock-user',
        botUserId: 'U999BOT',
        botRefreshToken: 'xoxe-1-bot-refresh',
        botExpiresAt: Date.now() - 60_000,
      },
    });

    vi.stubEnv('SLACK_CONFIG_PATH', cfg.configPath);
    vi.stubEnv('SLACK_TEAM_ID', 'T123');
    vi.stubEnv('SLACK_CLIENT_ID', 'mock-client-id');
    vi.stubEnv('SLACK_CLIENT_SECRET', 'mock-client-secret');

    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(cfg.configPath, 'T123', 'mock-client-id', 'mock-client-secret');

    const token = await tp.getBotToken();
    expect(token).toBe('xoxb-rotated');
    expect(oauthCalled).toBe(true);
  });
});
