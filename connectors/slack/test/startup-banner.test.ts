/**
 * HIGH-5 — Startup mode banner regression tests.
 *
 * § 6.1 requires every connector to log auth mode + env wiring at
 * startup. Verifies the banner is emitted with the expected fields and
 * never leaks secrets, across the relevant env combinations.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('startup banner', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-banner-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The banner redacts a homedir-prefixed config path to `~/...` (round-5
  // log-hygiene fix). On Windows, os.tmpdir() lives inside %USERPROFILE%,
  // so compute the expected representation rather than asserting tmpDir
  // verbatim — both branches are covered by the explicit redaction test
  // below.
  const expectedConfigPath = (raw: string): string => {
    const home = os.homedir();
    if (home && raw.startsWith(home + path.sep)) return '~' + raw.slice(home.length);
    if (home && raw === home) return '~';
    return raw;
  };

  it('emits auth_mode=host_injected, version, team_id, config_path, refresh_disabled, token_source', async () => {
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    vi.stubEnv('SLACK_TEAM_ID', 'T0123ABCD');
    const { formatStartupBanner } = await import('../src/startupBanner.js');
    const banner = formatStartupBanner();
    expect(banner).toContain('auth_mode=host_injected');
    expect(banner).toMatch(/version=\d+\.\d+\.\d+/);
    expect(banner).toContain('team_id=T0123ABCD');
    expect(banner).toContain(`config_path=${expectedConfigPath(tmpDir)}`);
    expect(banner).toContain('refresh_disabled=false');
    expect(banner).toContain('token_source=missing');
  });

  it('redacts homedir-prefixed config_path to ~/... so logs do not leak OS username (round-5 log hygiene)', async () => {
    // Construct a path that always lives inside homedir.
    const home = os.homedir();
    const synthetic = path.join(home, '.mcp', 'slack', 'fixture-config');
    vi.stubEnv('SLACK_CONFIG_PATH', synthetic);
    vi.stubEnv('SLACK_TEAM_ID', 'T0123ABCD');
    const { formatStartupBanner } = await import('../src/startupBanner.js');
    const banner = formatStartupBanner();
    expect(banner).not.toContain(home);
    expect(banner).toMatch(/config_path=~[/\\]\.mcp[/\\]slack[/\\]fixture-config/);
  });

  it('reports team_id=<unset> when SLACK_TEAM_ID is missing', async () => {
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    vi.stubEnv('SLACK_TEAM_ID', '');
    const { formatStartupBanner } = await import('../src/startupBanner.js');
    const banner = formatStartupBanner();
    expect(banner).toContain('team_id=<unset>');
  });

  it('reports refresh_disabled=true when SLACK_DISABLE_REFRESH=1', async () => {
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    vi.stubEnv('SLACK_TEAM_ID', 'T0123ABCD');
    vi.stubEnv('SLACK_DISABLE_REFRESH', '1');
    const { formatStartupBanner } = await import('../src/startupBanner.js');
    const banner = formatStartupBanner();
    expect(banner).toContain('refresh_disabled=true');
  });

  it('reports token_source=disk when the on-disk token file exists', async () => {
    const wsDir = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(wsDir, 'T0123ABCD.json'),
      JSON.stringify({ botToken: 'xoxb-x', botUserId: 'U999' }),
      { mode: 0o600 },
    );
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    vi.stubEnv('SLACK_TEAM_ID', 'T0123ABCD');
    const { formatStartupBanner } = await import('../src/startupBanner.js');
    const banner = formatStartupBanner();
    expect(banner).toContain('token_source=disk');
  });

  it('never echoes SLACK_CLIENT_SECRET in the banner even when set', async () => {
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    vi.stubEnv('SLACK_TEAM_ID', 'T0123ABCD');
    vi.stubEnv('SLACK_CLIENT_SECRET', 'super-secret-do-not-leak-1234567890');
    vi.stubEnv('SLACK_CLIENT_ID', 'public-client-id-but-still-omit');
    const { formatStartupBanner } = await import('../src/startupBanner.js');
    const banner = formatStartupBanner();
    expect(banner).not.toContain('super-secret-do-not-leak-1234567890');
    expect(banner).not.toContain('public-client-id-but-still-omit');
  });

  it('logStartupBanner writes to stderr (single line)', async () => {
    vi.stubEnv('SLACK_CONFIG_PATH', tmpDir);
    vi.stubEnv('SLACK_TEAM_ID', 'T0123ABCD');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { logStartupBanner } = await import('../src/startupBanner.js');
    logStartupBanner();
    const calls = errSpy.mock.calls.map((c) => c[0] as string);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('auth_mode=host_injected');
    errSpy.mockRestore();
  });
});

describe('refresh log sanitization (round-5 log hygiene)', () => {
  // Defence: a misbehaving upstream could surface a token-shape value as the
  // Slack `error` field. The structured refresh logger must redact it.
  it('logRefreshEvent redacts a token-shaped slack_error_code via sanitizeErrorMessage', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { __testOnlyLogRefreshEvent } = await import('../src/tokenProvider.js');
      __testOnlyLogRefreshEvent('refresh_failure', {
        teamId: 'T123',
        tokenType: 'bot',
        outcomeCode: 'REFRESH_AUTH_REJECTED',
        // Pretend an upstream proxy stuffed a token into the error field.
        slackErrorCode: 'xoxb-9999-leaked-via-error-field',
        message: 'auth rejected',
      });
      const calls = errSpy.mock.calls.map((c) => c[0] as string);
      expect(calls.length).toBe(1);
      expect(calls[0]).not.toContain('xoxb-9999-leaked-via-error-field');
      expect(calls[0]).toContain('[REDACTED]');
    } finally {
      errSpy.mockRestore();
    }
  });
});
