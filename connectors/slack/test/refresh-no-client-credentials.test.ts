import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mswServer } from './fixtures/setup.js';
import { http, HttpResponse } from 'msw';
import { createSlackHandlers, SLACK_API_BASE } from './fixtures/slack-mock-api.js';
import { createSlackConfigDir, type SlackTestConfig } from './fixtures/mcp-test-client.js';

/**
 * Saved (host-injected) tokens must be usable WITHOUT OAuth client credentials.
 * Client id/secret are only needed to refresh a rotating token — a missing
 * pair must not gate access to non-rotating saved tokens, and must fail loud
 * (not silently) when a refresh genuinely cannot proceed.
 */
describe('OAuth client credentials are optional for saved-token access', () => {
  let cfg: SlackTestConfig;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (cfg) cfg.cleanup();
    vi.unstubAllEnvs();
  });

  it('serves a non-rotating saved bot token when client id/secret are absent', async () => {
    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-saved-no-refresh',
        userToken: 'xoxp-saved-no-refresh',
        botUserId: 'U999BOT',
        // no botRefreshToken / botExpiresAt → non-rotating
      },
    });

    vi.stubEnv('SLACK_CONFIG_PATH', cfg.configPath);
    vi.stubEnv('SLACK_TEAM_ID', 'T123');
    vi.stubEnv('SLACK_CLIENT_ID', '');
    vi.stubEnv('SLACK_CLIENT_SECRET', '');

    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(cfg.configPath, 'T123', '', '');

    await expect(tp.getBotToken()).resolves.toBe('xoxb-saved-no-refresh');
  });

  it('throws REFRESH_NO_CLIENT_CREDENTIALS (without calling Slack) when a rotating token needs refresh but client creds are absent', async () => {
    let oauthCalled = false;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, () => {
        oauthCalled = true;
        return HttpResponse.json({ ok: true, access_token: 'xoxb-rotated', expires_in: 43200 });
      }),
      ...createSlackHandlers(),
    );

    cfg = createSlackConfigDir({
      tokens: {
        botToken: 'xoxb-expired',
        userToken: 'xoxp-expired',
        botUserId: 'U999BOT',
        botRefreshToken: 'xoxe-1-bot-refresh',
        botExpiresAt: Date.now() - 60_000, // expired → refresh required
      },
    });

    vi.stubEnv('SLACK_CONFIG_PATH', cfg.configPath);
    vi.stubEnv('SLACK_TEAM_ID', 'T123');
    vi.stubEnv('SLACK_CLIENT_ID', '');
    vi.stubEnv('SLACK_CLIENT_SECRET', '');

    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(cfg.configPath, 'T123', '', '');

    await expect(tp.getBotToken()).rejects.toMatchObject({
      code: 'REFRESH_NO_CLIENT_CREDENTIALS',
      nextStep: 'authenticate_slack_workspace',
    });
    expect(oauthCalled).toBe(false);
  });

  it('wraps a thrown REFRESH_NO_CLIENT_CREDENTIALS into the active auth_required tool response (not a passive ok:false)', async () => {
    const { withErrorHandling } = await import('../src/utils.js');
    const { ConnectorError, REFRESH_NO_CLIENT_CREDENTIALS } = await import('../src/types.js');

    const handler = withErrorHandling(async () => {
      throw new ConnectorError(
        'Slack token needs refreshing but no OAuth client credentials are configured on this surface.',
        REFRESH_NO_CLIENT_CREDENTIALS,
        'Re-authenticate the Slack workspace via your MCP host application to provision fresh tokens.',
      );
    });

    const result = await handler({} as never, undefined);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text as string) as Record<string, unknown>;
    // Must be the active auth_required shape the host's AuthOrchestrator acts on,
    // NOT a passive { ok: false } the user can't recover from.
    expect(payload.status).toBe('auth_required');
    expect(payload.ok).toBeUndefined();
  });
});
