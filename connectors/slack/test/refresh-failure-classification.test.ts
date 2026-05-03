/**
 * HIGH-3 / HIGH-4 / HIGH-6 — refresh failure classification + auth_required
 * routing + structured logging.
 *
 * The provider must distinguish:
 *   - `REFRESH_TRANSIENT` — network errors, HTTP 5xx
 *   - `REFRESH_RATE_LIMITED` — HTTP 429 (with retry_after_seconds)
 *   - `REFRESH_AUTH_REJECTED` — Slack `invalid_grant` / `invalid_refresh_token` /
 *     `token_revoked` / `token_expired` / `account_inactive` / `invalid_auth`
 *   - `REFRESH_MALFORMED_RESPONSE` — Slack returned ok:true but no access_token
 *
 * `withErrorHandling` must route `REFRESH_AUTH_REJECTED` to the
 * structured `auth_required` shape the host's Stage 0
 * `AuthRequiredResponseSchema` listens for. Other classes surface as
 * `{ ok:false, code:..., next_step:..., retry_after_seconds?:number }`.
 *
 * Each refresh outcome must be logged with structured fields.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';
import { SLACK_API_BASE } from './fixtures/slack-mock-api.js';
import { Stage0AuthRequiredSchema } from './fixtures/stage0-auth-schema.js';

describe('refresh failure classification — direct provider tests', () => {
  let tmpDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-refresh-class-'));
    const wsDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(wsDir, 'T123.json'),
      JSON.stringify({
        botToken: 'xoxb-stale',
        botUserId: 'U999BOT',
        botRefreshToken: 'xoxe-1-stale',
        botExpiresAt: Date.now() - 60_000,
      }),
      { mode: 0o600 },
    );
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function stderr(): string {
    return errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  }

  it('Network error during refresh classifies as REFRESH_TRANSIENT', async () => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, () => HttpResponse.error()),
    );
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T123', 'cid', 'csec');
    let caught: { code?: string } | null = null;
    try {
      await tp.getBotToken();
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).toBe('REFRESH_TRANSIENT');
    const logs = stderr();
    expect(logs).toContain('refresh_attempt');
    expect(logs).toContain('refresh_failure');
    expect(logs).toContain('REFRESH_TRANSIENT');
    expect(logs).toContain('"team_id":"T123"');
  });

  it('HTTP 429 classifies as REFRESH_RATE_LIMITED with retry_after_seconds in extra', async () => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, () =>
        HttpResponse.text('rate limited', {
          status: 429,
          headers: { 'retry-after': '17' },
        }),
      ),
    );
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T123', 'cid', 'csec');
    let caught: { code?: string; extra?: Record<string, unknown> } | null = null;
    try {
      await tp.getBotToken();
    } catch (err) {
      caught = err as { code?: string; extra?: Record<string, unknown> };
    }
    expect(caught?.code).toBe('REFRESH_RATE_LIMITED');
    expect(caught?.extra?.retry_after_seconds).toBe(17);
    const logs = stderr();
    expect(logs).toContain('REFRESH_RATE_LIMITED');
    expect(logs).toContain('17');
  });

  it('Slack ok:false error:invalid_grant classifies as REFRESH_AUTH_REJECTED with slack_error_code', async () => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, () =>
        HttpResponse.json({ ok: false, error: 'invalid_grant' }),
      ),
    );
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T123', 'cid', 'csec');
    let caught: { code?: string; extra?: Record<string, unknown> } | null = null;
    try {
      await tp.getBotToken();
    } catch (err) {
      caught = err as { code?: string; extra?: Record<string, unknown> };
    }
    expect(caught?.code).toBe('REFRESH_AUTH_REJECTED');
    expect(caught?.extra?.slack_error_code).toBe('invalid_grant');
    const logs = stderr();
    expect(logs).toContain('REFRESH_AUTH_REJECTED');
    expect(logs).toContain('invalid_grant');
  });

  it('Slack ok:true missing access_token classifies as REFRESH_MALFORMED_RESPONSE', async () => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, () =>
        HttpResponse.json({ ok: true, expires_in: 43200 }),
      ),
    );
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T123', 'cid', 'csec');
    let caught: { code?: string } | null = null;
    try {
      await tp.getBotToken();
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).toBe('REFRESH_MALFORMED_RESPONSE');
    const logs = stderr();
    expect(logs).toContain('REFRESH_MALFORMED_RESPONSE');
  });

  it('HTTP 500 classifies as REFRESH_TRANSIENT', async () => {
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, () =>
        HttpResponse.text('upstream', { status: 502 }),
      ),
    );
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T123', 'cid', 'csec');
    let caught: { code?: string } | null = null;
    try {
      await tp.getBotToken();
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).toBe('REFRESH_TRANSIENT');
  });
});

describe('refresh failure → tool response shape via withErrorHandling', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('REFRESH_AUTH_REJECTED routes through auth_required (Stage0AuthRequiredSchema)', async () => {
    const { withErrorHandling } = await import('../src/utils.js');
    const { ConnectorError } = await import('../src/types.js');
    const handler = withErrorHandling(async () => {
      throw new ConnectorError(
        'Slack rejected refresh',
        'REFRESH_AUTH_REJECTED',
        'reauth required',
        { slack_error_code: 'invalid_grant' },
      );
    });
    const result = await handler({}, {});
    const text = (result.content[0] as { text: string }).text;
    const j = JSON.parse(text);
    expect(j.status).toBe('auth_required');
    expect(j.user_action).toMatchObject({ id: 'slack.connect_workspace' });
    expect(j.agent_action.instruction).toBeTruthy();
    expect(j.setupToolName).toBe('authenticate_slack_workspace');
    const parsed = Stage0AuthRequiredSchema.safeParse(j);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('NO_TOKEN routes through auth_required (Stage0AuthRequiredSchema)', async () => {
    const { withErrorHandling } = await import('../src/utils.js');
    const { ConnectorError } = await import('../src/types.js');
    const handler = withErrorHandling(async () => {
      throw new ConnectorError('No bot token', 'NO_TOKEN', 'connect first');
    });
    const result = await handler({}, {});
    const j = JSON.parse((result.content[0] as { text: string }).text);
    expect(j.status).toBe('auth_required');
    const parsed = Stage0AuthRequiredSchema.safeParse(j);
    expect(parsed.success).toBe(true);
  });

  it('REFRESH_TRANSIENT does NOT route to auth_required — surfaces { ok:false, code, next_step }', async () => {
    const { withErrorHandling } = await import('../src/utils.js');
    const { ConnectorError } = await import('../src/types.js');
    const handler = withErrorHandling(async () => {
      throw new ConnectorError('transient blip', 'REFRESH_TRANSIENT', 'retry shortly');
    });
    const result = await handler({}, {});
    const j = JSON.parse((result.content[0] as { text: string }).text);
    expect(j.status).toBeUndefined();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('REFRESH_TRANSIENT');
    expect(j.next_step).toBe('retry_after_delay');
  });

  it('REFRESH_RATE_LIMITED surfaces retry_after_seconds in response body', async () => {
    const { withErrorHandling } = await import('../src/utils.js');
    const { ConnectorError } = await import('../src/types.js');
    const handler = withErrorHandling(async () => {
      throw new ConnectorError(
        'rate limited',
        'REFRESH_RATE_LIMITED',
        'wait',
        { retry_after_seconds: 42 },
      );
    });
    const result = await handler({}, {});
    const j = JSON.parse((result.content[0] as { text: string }).text);
    expect(j.code).toBe('REFRESH_RATE_LIMITED');
    expect(j.retry_after_seconds).toBe(42);
    expect(j.next_step).toBe('retry_after_delay');
  });

  it('REFRESH_MALFORMED_RESPONSE surfaces as { ok:false, code:REFRESH_MALFORMED_RESPONSE, next_step:authenticate_slack_workspace }', async () => {
    const { withErrorHandling } = await import('../src/utils.js');
    const { ConnectorError } = await import('../src/types.js');
    const handler = withErrorHandling(async () => {
      throw new ConnectorError(
        'malformed',
        'REFRESH_MALFORMED_RESPONSE',
        'reauth',
      );
    });
    const result = await handler({}, {});
    const j = JSON.parse((result.content[0] as { text: string }).text);
    expect(j.ok).toBe(false);
    expect(j.code).toBe('REFRESH_MALFORMED_RESPONSE');
    expect(j.next_step).toBe('authenticate_slack_workspace');
    expect(j.status).toBeUndefined();
  });
});
