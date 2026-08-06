/**
 * CRITICAL-1 — refresh-burn race regression tests.
 *
 * When `saveTokens()` fails AFTER Slack has rotated the refresh token, the
 * provider must:
 *   (a) keep the freshly-rotated tokens in memory (NOT call loadTokens()
 *       to overwrite cachedTokens with the now-stale on-disk value);
 *   (b) propagate `TOKEN_PERSIST_FAILED` distinctly (NOT remap to
 *       `REFRESH_FAILED`);
 *   (c) call Slack's `oauth.v2.access` exactly ONCE — re-issuing the
 *       refresh would attempt to use the now-burned single-use token.
 *
 * After process restart, the stale on-disk file should drive an expired-
 * token path that emits `auth_required`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { mswServer } from './fixtures/setup.js';
import { http, HttpResponse } from 'msw';
import { SLACK_API_BASE } from './fixtures/slack-mock-api.js';

describe('CRITICAL-1 — saveTokens failure does not burn the rotated refresh token', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-persist-fail-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(typeof process.geteuid === 'function' && process.geteuid() === 0)('keeps rotated tokens in memory; surfaces TOKEN_PERSIST_FAILED distinctly; calls oauth.v2.access exactly once', async () => {
    let oauthCallCount = 0;
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, async () => {
        oauthCallCount++;
        return HttpResponse.json({
          ok: true,
          access_token: 'xoxb-rotated-fresh',
          refresh_token: 'xoxe-1-rotated-fresh',
          expires_in: 43200,
        });
      }),
    );

    const wsDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    const tokenFile = path.join(wsDir, 'T123.json');
    const stale = {
      botToken: 'xoxb-stale-on-disk',
      botUserId: 'U999BOT',
      botRefreshToken: 'xoxe-1-stale',
      botExpiresAt: Date.now() - 60_000,
    };
    fs.writeFileSync(tokenFile, JSON.stringify(stale, null, 2), { mode: 0o600 });

    // Make the workspaces dir read-only mid-test by chmod-ing it after the
    // initial write — rename into a read-only directory fails. This avoids
    // the ESM "Cannot spy on namespace export" limitation while still
    // exercising a realistic disk-write failure.
    if (process.platform === 'win32') {
      // Windows: spy approach is unavailable; fall through with a different
      // failure injection — overwrite the temp file path with a directory
      // to force renameSync to fail.
      fs.mkdirSync(path.join(wsDir, 'fake.tmp.dir'), { recursive: true });
    } else {
      fs.chmodSync(wsDir, 0o500);
    }

    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T123', 'cid', 'csec');

    let caught: { code?: string; message?: string } | null = null;
    try {
      await tp.getBotToken();
    } catch (err) {
      caught = err as { code?: string; message?: string };
    }

    // Restore mode for cleanup.
    if (process.platform !== 'win32') {
      fs.chmodSync(wsDir, 0o700);
    }

    expect(caught, 'getBotToken must reject when persistence fails').toBeTruthy();
    expect(caught!.code).toBe('TOKEN_PERSIST_FAILED');

    // (c) Slack was called exactly once — the second attempt would burn the
    // rotated refresh token.
    expect(oauthCallCount).toBe(1);

    // (a) cachedTokens still holds the rotated values — NOT the stale
    // on-disk values. If loadTokens() leaked into the catch path the
    // bot token would be 'xoxb-stale-on-disk' here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cached = (tp as any).cachedTokens as { botToken: string; botRefreshToken: string };
    expect(cached.botToken).toBe('xoxb-rotated-fresh');
    expect(cached.botRefreshToken).toBe('xoxe-1-rotated-fresh');

    // Subsequent in-memory call uses the rotated tokens (no second refresh).
    const followUp = await tp.getBotToken();
    expect(followUp).toBe('xoxb-rotated-fresh');
    expect(oauthCallCount).toBe(1);
  });

  it('after process restart with stale on-disk file, next call hits expired-token path', async () => {
    // Simulate: a previous process rotated tokens but failed to persist; on
    // restart the only thing on disk is the stale token. Refresh runs and
    // succeeds (Slack hasn't actually invalidated the stale refresh in this
    // simulation — the burn only happens if you call oauth.v2.access TWICE
    // with the same refresh).
    mswServer.use(
      http.post(`${SLACK_API_BASE}/oauth.v2.access`, () =>
        HttpResponse.json({
          ok: true,
          access_token: 'xoxb-restart-rotated',
          refresh_token: 'xoxe-1-restart-rotated',
          expires_in: 43200,
        }),
      ),
    );
    const wsDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    const tokenFile = path.join(wsDir, 'T123.json');
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({
        botToken: 'xoxb-stale-after-restart',
        botUserId: 'U999BOT',
        botRefreshToken: 'xoxe-1-stale-after-restart',
        botExpiresAt: Date.now() - 60_000,
      }),
      { mode: 0o600 },
    );

    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T123', 'cid', 'csec');
    const token = await tp.getBotToken();
    expect(token).toBe('xoxb-restart-rotated');
  });

  it('with SLACK_DISABLE_REFRESH=1 and stale on-disk file, surfaces TOKEN_EXPIRED_REFRESH_DISABLED (would route to auth_required)', async () => {
    const wsDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    const tokenFile = path.join(wsDir, 'T123.json');
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({
        botToken: 'xoxb-stale',
        botUserId: 'U999BOT',
        botRefreshToken: 'xoxe-1-stale',
        botExpiresAt: Date.now() - 60_000,
      }),
      { mode: 0o600 },
    );

    vi.stubEnv('SLACK_DISABLE_REFRESH', '1');
    const { SlackTokenProvider } = await import('../src/tokenProvider.js');
    const tp = new SlackTokenProvider(tmpDir, 'T123', 'cid', 'csec');
    await expect(tp.getBotToken()).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED_REFRESH_DISABLED',
    });
  });
});
