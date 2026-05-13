import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __getRefreshStateForTests,
  __resetRefreshStateForTests,
  __setRefreshNowProviderForTests,
  RefreshCooldownActiveError,
  RefreshMalformedResponseError,
  RefreshRateLimitedError,
  RefreshTransientError,
  refreshTokenForAccount,
} from '../src/modules/accounts/oauth.js';
import { __resetAccountManagerForTests, type TokenData } from '../src/modules/accounts/manager.js';
import { parseHubSpotError } from '../src/utils/error-parser.js';

const TEST_EMAIL = 'refresh@example.com';

function createConfigDir(prefix: string): string {
  const configDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  return configDir;
}

function createExpiringToken(): TokenData {
  return {
    access_token: 'old-access-token',
    refresh_token: 'old-refresh-token',
    expires_at: Date.now() - 5_000,
    hub_id: 999,
    user: TEST_EMAIL,
    schemaVersion: 1,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetRefreshStateForTests();
  __resetAccountManagerForTests();
  delete process.env.HUBSPOT_CONFIG_DIR;
  delete process.env.HUBSPOT_CLIENT_ID;
  delete process.env.HUBSPOT_CLIENT_SECRET;
  delete process.env.HUBSPOT_DISABLE_REFRESH;
  delete process.env.HUBSPOT_ALLOW_CLOUD_REFRESH;
});

describe('HubSpot refresh failure mapping', () => {
  it('maps refresh rate limits without a raw details payload', () => {
    const parsed = parseHubSpotError(new RefreshRateLimitedError(17), {
      objectType: 'tokens',
      operation: 'refresh',
    });

    expect(parsed).toMatchObject({
      errorCode: 'REFRESH_RATE_LIMITED',
      retryAfterSeconds: 17,
    });
    expect(JSON.stringify(parsed)).not.toContain('details');
  });

  it('maps invalid_grant to auth_required result', async () => {
    const configDir = createConfigDir('hubspot-refresh-invalid-grant-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_CLIENT_ID = 'client-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'client-secret';

    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
      lockOptions: { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } },
    });

    expect(result.status).toBe('auth_required');
    expect(result.reason).toBe('invalid_grant');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('maps HTTP 5xx to RefreshTransientError', async () => {
    const configDir = createConfigDir('hubspot-refresh-5xx-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_CLIENT_ID = 'client-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'client-secret';

    vi.stubGlobal('fetch', vi.fn(async () => new Response('server down', { status: 503 })));

    await expect(refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
      lockOptions: { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } },
    })).rejects.toBeInstanceOf(RefreshTransientError);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('maps HTTP 429 to RefreshRateLimitedError with retry_after', async () => {
    const configDir = createConfigDir('hubspot-refresh-429-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_CLIENT_ID = 'client-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'client-secret';

    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', {
      status: 429,
      headers: { 'retry-after': '17' },
    })));

    await expect(refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
      lockOptions: { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } },
    })).rejects.toMatchObject({
      name: 'RefreshRateLimitedError',
      retryAfterSeconds: 17,
    } satisfies Partial<RefreshRateLimitedError>);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('maps malformed refresh JSON to RefreshMalformedResponseError', async () => {
    const configDir = createConfigDir('hubspot-refresh-malformed-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_CLIENT_ID = 'client-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'client-secret';

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })));

    await expect(refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
      lockOptions: { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } },
    })).rejects.toBeInstanceOf(RefreshMalformedResponseError);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('returns auth_required without HTTP call when HUBSPOT_DISABLE_REFRESH=1', async () => {
    const configDir = createConfigDir('hubspot-refresh-disabled-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_CLIENT_ID = 'client-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'client-secret';
    process.env.HUBSPOT_DISABLE_REFRESH = '1';

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshTokenForAccount(TEST_EMAIL, createExpiringToken());

    expect(result).toEqual({ status: 'auth_required', reason: 'refresh_disabled' });
    expect(fetchMock).not.toHaveBeenCalled();

    rmSync(configDir, { recursive: true, force: true });
  });

  it('allows HTTP refresh when HUBSPOT_ALLOW_CLOUD_REFRESH=1 overrides disable flag', async () => {
    const configDir = createConfigDir('hubspot-refresh-allow-cloud-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_CLIENT_ID = 'client-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'client-secret';
    process.env.HUBSPOT_DISABLE_REFRESH = '1';
    process.env.HUBSPOT_ALLOW_CLOUD_REFRESH = '1';

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
      lockOptions: { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } },
    });

    expect(result.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('does not extend cooldown window under repeated cooldown retries and resumes HTTP after cooldown', async () => {
    const configDir = createConfigDir('hubspot-refresh-cooldown-monotonic-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_CLIENT_ID = 'client-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'client-secret';

    let now = Date.now();
    __setRefreshNowProviderForTests(() => now);

    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length <= 3) {
        return new Response('upstream outage', { status: 503 });
      }
      return new Response(JSON.stringify({
        access_token: 'recovered-access-token',
        refresh_token: 'recovered-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 3; i++) {
      await expect(refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
        lockOptions: { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } },
      })).rejects.toBeInstanceOf(RefreshTransientError);
      now += 1_000;
    }

    const cooldownState = __getRefreshStateForTests(TEST_EMAIL);
    expect(cooldownState.cooldownUntil).toBeDefined();
    const openedCooldownUntil = cooldownState.cooldownUntil!;

    for (let retry = 0; retry < 10; retry++) {
      now += 2_000;
      await expect(refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
        lockOptions: { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } },
      })).rejects.toBeInstanceOf(RefreshCooldownActiveError);
      expect(__getRefreshStateForTests(TEST_EMAIL).cooldownUntil).toBe(openedCooldownUntil);
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);

    now = openedCooldownUntil + 1;
    const result = await refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
      lockOptions: { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } },
    });

    expect(result.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    rmSync(configDir, { recursive: true, force: true });
  });
});
