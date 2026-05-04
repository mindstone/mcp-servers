import fs from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicCredentialWrite } from '../src/utils/atomicCredentialWrite.js';
import {
  LockReleaseFailedError,
  RefreshLockFailedError,
  withHubSpotCredentialLock,
} from '../src/utils/credentialLock.js';
import {
  __resetRefreshStateForTests,
  __setRefreshNowProviderForTests,
  RefreshTransientError,
  refreshTokenForAccount,
} from '../src/modules/accounts/oauth.js';
import {
  __resetAccountManagerForTests,
  getAccountManager,
  sanitizeEmail,
  TokenPersistFailedError,
  type TokenData,
} from '../src/modules/accounts/manager.js';

const TEST_EMAIL = 'lock-test@example.com';
const require = createRequire(import.meta.url);
const properLockfile = require('proper-lockfile') as {
  lock: (path: string, options: unknown) => Promise<() => Promise<void>>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createConfigDir(prefix: string): string {
  const configDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  return configDir;
}

function createExpiringToken(email = TEST_EMAIL): TokenData {
  return {
    access_token: 'old-access-token',
    refresh_token: 'old-refresh-token',
    expires_at: Date.now() - 5_000,
    hub_id: 555,
    user: email,
    schemaVersion: 1,
  };
}

function tokenPathFor(configDir: string, email = TEST_EMAIL): string {
  return join(configDir, 'credentials', `${sanitizeEmail(email)}.token.json`);
}

function lockDirFor(tokenPath: string): string {
  return `${tokenPath}.lock`;
}

const retryNone = { retries: 0, minTimeout: 1, maxTimeout: 1 };

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

describe('HubSpot credential lock behavior', () => {
  it('a) two concurrent refreshes in the same tick: one succeeds, one gets RefreshLockFailedError', async () => {
    const configDir = createConfigDir('hubspot-lock-concurrent-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_CLIENT_ID = 'client-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'client-secret';
    __resetAccountManagerForTests();
    __resetRefreshStateForTests();

    const fetchMock = vi.fn(async () => {
      await sleep(200);
      return new Response(JSON.stringify({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p1 = refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
      lockOptions: { retries: retryNone, staleMs: 5_000, updateMs: 100 },
    });
    const p2 = refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
      lockOptions: { retries: retryNone, staleMs: 5_000, updateMs: 100 },
    });

    const settled = await Promise.allSettled([p1, p2]);
    const fulfilledCount = settled.filter((result) => result.status === 'fulfilled').length;
    const rejected = settled.find((result) => result.status === 'rejected');

    expect(fulfilledCount).toBe(1);
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(RefreshLockFailedError);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('b) stale lock recovery succeeds after stale window', async () => {
    const configDir = createConfigDir('hubspot-lock-stale-recovery-');
    const tokenPath = tokenPathFor(configDir);
    const lockDir = lockDirFor(tokenPath);
    mkdirSync(lockDir, { recursive: true });

    const oldMtime = new Date(Date.now() - 180_000);
    utimesSync(lockDir, oldMtime, oldMtime);

    const result = await withHubSpotCredentialLock(
      tokenPath,
      async () => 'recovered',
      { staleMs: 90_000, updateMs: 5_000, retries: retryNone },
    );

    expect(result).toBe('recovered');
    rmSync(configDir, { recursive: true, force: true });
  });

  it('c) lock releases even when persist fails (EACCES)', async () => {
    const configDir = createConfigDir('hubspot-lock-release-on-persist-fail-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_CLIENT_ID = 'client-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'client-secret';
    __resetAccountManagerForTests();
    __resetRefreshStateForTests();

    const manager = getAccountManager();
    const tokenPath = manager.getTokenPathForEmail(TEST_EMAIL);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    await expect(refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
      lockOptions: { retries: retryNone, staleMs: 5_000, updateMs: 100 },
    })).rejects.toBeInstanceOf(TokenPersistFailedError);

    vi.restoreAllMocks();

    await expect(withHubSpotCredentialLock(
      tokenPath,
      async () => 'released',
      { retries: retryNone, staleMs: 5_000, updateMs: 100 },
    )).resolves.toBe('released');

    rmSync(configDir, { recursive: true, force: true });
  });

  it('d) heartbeat keeps lock alive during slow refresh; waiter does not acquire', async () => {
    const configDir = createConfigDir('hubspot-lock-heartbeat-');
    const tokenPath = tokenPathFor(configDir);

    const holder = withHubSpotCredentialLock(tokenPath, async () => {
      await sleep(700);
      return 'holder-done';
    }, {
      staleMs: 500,
      updateMs: 100,
      retries: retryNone,
    });

    await sleep(150);

    await expect(withHubSpotCredentialLock(
      tokenPath,
      async () => 'waiter',
      { staleMs: 500, updateMs: 100, retries: retryNone },
    )).rejects.toBeInstanceOf(RefreshLockFailedError);

    await expect(holder).resolves.toBe('holder-done');

    rmSync(configDir, { recursive: true, force: true });
  });

  it('e) NFS-style future mtime on lock directory recovers and releases cleanly', async () => {
    vi.useFakeTimers();
    try {
      const configDir = createConfigDir('hubspot-lock-nfs-clock-skew-');
      const tokenPath = tokenPathFor(configDir);
      const lockDir = lockDirFor(tokenPath);
      mkdirSync(lockDir, { recursive: true });

      const base = new Date('2026-05-04T00:00:00.000Z');
      vi.setSystemTime(base);
      const futureMtime = new Date(base.getTime() + 30_000);
      utimesSync(lockDir, futureMtime, futureMtime);

      const acquirePromise = withHubSpotCredentialLock(
        tokenPath,
        async () => 'acquired-after-skew',
        {
          staleMs: 2_000,
          updateMs: 100,
          retries: { retries: 500, minTimeout: 100, maxTimeout: 100 },
        },
      );

      await vi.advanceTimersByTimeAsync(32_500);
      await expect(acquirePromise).resolves.toBe('acquired-after-skew');
      await expect(withHubSpotCredentialLock(
        tokenPath,
        async () => 'released-cleanly',
        { staleMs: 2_000, updateMs: 100, retries: retryNone },
      )).resolves.toBe('released-cleanly');

      rmSync(configDir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('f) circuit breaker opens after 3 transient failures and cools down after 60s', async () => {
    const configDir = createConfigDir('hubspot-lock-circuit-breaker-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_CLIENT_ID = 'client-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'client-secret';
    __resetAccountManagerForTests();
    __resetRefreshStateForTests();

    let now = Date.now();
    __setRefreshNowProviderForTests(() => now);

    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length <= 3) {
        return new Response('temporary outage', { status: 503 });
      }
      return new Response(JSON.stringify({
        access_token: 'recovered-access-token',
        refresh_token: 'recovered-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
        lockOptions: { retries: retryNone, staleMs: 5_000, updateMs: 100 },
      })).rejects.toBeInstanceOf(RefreshTransientError);
      now += 1_000;
    }

    await expect(refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
      lockOptions: { retries: retryNone, staleMs: 5_000, updateMs: 100 },
    })).rejects.toBeInstanceOf(RefreshTransientError);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    now += 61_000;

    const recovered = await refreshTokenForAccount(TEST_EMAIL, createExpiringToken(), {
      lockOptions: { retries: retryNone, staleMs: 5_000, updateMs: 100 },
    });
    expect(recovered.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('g) future-mtime stale reclaim completes within stale + 30s window', async () => {
    vi.useFakeTimers();
    try {
      const configDir = createConfigDir('hubspot-lock-future-mtime-delay-');
      const tokenPath = tokenPathFor(configDir);
      const lockDir = lockDirFor(tokenPath);
      mkdirSync(lockDir, { recursive: true });

      const staleMs = 2_000;
      const base = new Date('2026-05-04T00:00:00.000Z');
      vi.setSystemTime(base);
      const futureMtime = new Date(base.getTime() + 30_000);
      utimesSync(lockDir, futureMtime, futureMtime);

      const startedAt = base.getTime();
      const acquirePromise = withHubSpotCredentialLock(
        tokenPath,
        async () => 'reclaimed',
        {
          staleMs,
          updateMs: 100,
          retries: { retries: 500, minTimeout: 100, maxTimeout: 100 },
        },
      );

      await vi.advanceTimersByTimeAsync(staleMs + 30_500);
      await expect(acquirePromise).resolves.toBe('reclaimed');

      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThanOrEqual(staleMs + 30_500);

      rmSync(configDir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('h) simultaneous stale reclaim: one acquires, one gets RefreshLockFailedError, follow-up succeeds', async () => {
    const configDir = createConfigDir('hubspot-lock-simultaneous-stale-');
    const tokenPath = tokenPathFor(configDir);
    const lockDir = lockDirFor(tokenPath);
    mkdirSync(lockDir, { recursive: true });

    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lockDir, oldTime, oldTime);

    const contenderA = withHubSpotCredentialLock(tokenPath, async () => {
      await sleep(150);
      return 'A';
    }, {
      staleMs: 500,
      updateMs: 100,
      retries: retryNone,
    });

    const contenderB = withHubSpotCredentialLock(tokenPath, async () => {
      await sleep(150);
      return 'B';
    }, {
      staleMs: 500,
      updateMs: 100,
      retries: retryNone,
    });

    const settled = await Promise.allSettled([contenderA, contenderB]);
    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    const rejected = settled.find((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(RefreshLockFailedError);
    }

    await expect(withHubSpotCredentialLock(
      tokenPath,
      async () => 'retry-success',
      { staleMs: 500, updateMs: 100, retries: retryNone },
    )).resolves.toBe('retry-success');

    rmSync(configDir, { recursive: true, force: true });
  });

  it('i) assertLockHealthy defense-layer blocks writes when lock directory is removed', async () => {
    const configDir = createConfigDir('hubspot-lock-assert-healthy-');
    const tokenPath = tokenPathFor(configDir);

    writeFileSync(tokenPath, JSON.stringify({ access_token: 'old-access-token', schemaVersion: 1 }, null, 2));

    await expect(withHubSpotCredentialLock(tokenPath, async (assertLockHealthy) => {
      const lockDir = lockDirFor(tokenPath);
      rmSync(lockDir, { recursive: true, force: true });
      assertLockHealthy();
      await atomicCredentialWrite(
        tokenPath,
        JSON.stringify({ access_token: 'new-access-token', schemaVersion: 1 }, null, 2),
        { mode: 0o600 },
      );
    }, {
      staleMs: 2_000,
      updateMs: 50,
      retries: retryNone,
    })).rejects.toBeInstanceOf(RefreshLockFailedError);

    const persisted = JSON.parse(readFileSync(tokenPath, 'utf-8')) as { access_token: string };
    expect(persisted.access_token).toBe('old-access-token');

    rmSync(configDir, { recursive: true, force: true });
  });

  it('j) onCompromised heartbeat path captures tracker error and fails persistence closed', async () => {
    const configDir = createConfigDir('hubspot-lock-on-compromised-heartbeat-');
    const tokenPath = tokenPathFor(configDir);
    writeFileSync(tokenPath, JSON.stringify({ access_token: 'old-access-token', schemaVersion: 1 }, null, 2));

    let persistStepError: unknown;

    await expect(withHubSpotCredentialLock(tokenPath, async (assertLockHealthy) => {
      const lockDir = lockDirFor(tokenPath);
      await sleep(1_100); // first heartbeat tick succeeds
      rmSync(lockDir, { recursive: true, force: true }); // external deletion

      const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      try {
        let compromiseObserved = false;
        for (let attempt = 0; attempt < 120; attempt++) {
          await sleep(25);
          try {
            assertLockHealthy();
          } catch {
            compromiseObserved = true;
            break;
          }
        }
        expect(compromiseObserved).toBe(true);

        await (async () => {
          assertLockHealthy();
          await atomicCredentialWrite(
            tokenPath,
            JSON.stringify({ access_token: 'new-access-token', schemaVersion: 1 }, null, 2),
            { mode: 0o600 },
          );
        })();
      } catch (error) {
        persistStepError = error;
        throw error;
      } finally {
        existsSpy.mockRestore();
      }
    }, {
      staleMs: 5_000,
      updateMs: 1_000,
      retries: retryNone,
    })).rejects.toBeInstanceOf(RefreshLockFailedError);

    expect(persistStepError).toBeInstanceOf(RefreshLockFailedError);
    if (persistStepError instanceof RefreshLockFailedError) {
      expect(persistStepError.cause).toBeInstanceOf(Error);
    }

    const persisted = JSON.parse(readFileSync(tokenPath, 'utf-8')) as { access_token: string };
    expect(persisted.access_token).toBe('old-access-token');

    rmSync(configDir, { recursive: true, force: true });
  });

  it('k) release failure on success path surfaces LockReleaseFailedError', async () => {
    const configDir = createConfigDir('hubspot-lock-release-failure-');
    const tokenPath = tokenPathFor(configDir);
    mkdirSync(lockDirFor(tokenPath), { recursive: true });

    const releaseFailure = new Error('release failed');
    const lockSpy = vi.spyOn(properLockfile, 'lock').mockResolvedValueOnce(async () => {
      throw releaseFailure;
    });

    await expect(withHubSpotCredentialLock(
      tokenPath,
      async () => 'work-done',
      { staleMs: 2_000, updateMs: 100, retries: retryNone },
    )).rejects.toBeInstanceOf(LockReleaseFailedError);

    lockSpy.mockRestore();
    rmSync(configDir, { recursive: true, force: true });
  });
});
