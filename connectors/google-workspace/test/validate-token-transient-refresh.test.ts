import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for the transient-refresh handling on the *operations* path
 * (`validateToken` + `BaseGoogleService.getAuthenticatedClient`).
 *
 * `autoRenewToken` already retried a non-`invalid_grant` refresh failure once and flagged the
 * still-failing case as `canRetry: true`. `validateToken` did neither: a single transient network
 * blip during refresh returned `{ valid: false, status: 'REFRESH_FAILED' }` with no retry and no
 * `canRetry`, so a live grant looked dead. `BaseGoogleService.getAuthenticatedClient` then threw a
 * blanket "authentication required" error.
 *
 * The fix mirrors `autoRenewToken`: `validateToken` retries once and, if it still fails on a
 * non-`invalid_grant` error, returns `canRetry: true`; `getAuthenticatedClient` maps that to a
 * retryable `TEMPORARY_AUTH_ERROR` rather than an `AUTH_REQUIRED` reconnect demand.
 *
 * Injection style follows `disable-refresh.test.ts`: a `TokenManager` constructed with a stub
 * OAuth client whose `refreshToken` is driven per-test, so assertions don't depend on gaxios
 * error-message formatting.
 */
describe('validateToken transient-refresh retry + canRetry', () => {
  let cleanupDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (cleanupDir) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  function seedExpiredToken(): string {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-validate-transient-'));
    const credentialsPath = path.join(cleanupDir, 'credentials');
    fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(credentialsPath, 'user-example-com.token.json'),
      JSON.stringify({
        access_token: 'expired-access-token',
        refresh_token: 'refresh-token',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        expiry_date: Date.now() - 60_000,
      }),
      { mode: 0o600 },
    );
    return credentialsPath;
  }

  it('retries once and reports canRetry on a persistent transient (non-invalid_grant) error', async () => {
    vi.stubEnv('CREDENTIALS_PATH', seedExpiredToken());
    vi.resetModules();
    const { TokenManager } = await import('../src/modules/accounts/token.js');

    let attempts = 0;
    const tokenManager = new TokenManager({
      refreshToken: async () => {
        attempts += 1;
        throw new Error('temporarily unavailable');
      },
    } as never);

    const status = await tokenManager.validateToken('user@example.com');

    expect(attempts).toBe(2); // one initial attempt + one retry, mirroring autoRenewToken
    expect(status).toMatchObject({
      valid: false,
      status: 'REFRESH_FAILED',
      canRetry: true,
    });
    expect(status.reason).toMatch(/temporary/i);
  });

  it('recovers when the retry succeeds (no canRetry, valid token)', async () => {
    vi.stubEnv('CREDENTIALS_PATH', seedExpiredToken());
    vi.resetModules();
    const { TokenManager } = await import('../src/modules/accounts/token.js');

    let attempts = 0;
    const tokenManager = new TokenManager({
      refreshToken: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporarily unavailable');
        return {
          access_token: 'fresh-access-token',
          expiry_date: Date.now() + 3_600_000,
        };
      },
    } as never);

    const status = await tokenManager.validateToken('user@example.com');

    expect(attempts).toBe(2);
    expect(status).toMatchObject({ valid: true, status: 'REFRESHED' });
    expect(status.canRetry).toBeUndefined();
  });

  it('does not retry an invalid_grant error (dead grant stays AUTH_REQUIRED, no canRetry)', async () => {
    vi.stubEnv('CREDENTIALS_PATH', seedExpiredToken());
    vi.resetModules();
    const { TokenManager } = await import('../src/modules/accounts/token.js');

    let attempts = 0;
    const tokenManager = new TokenManager({
      refreshToken: async () => {
        attempts += 1;
        throw new Error('invalid_grant');
      },
    } as never);

    const status = await tokenManager.validateToken('user@example.com');

    expect(attempts).toBe(1); // invalid_grant is terminal — no retry
    expect(status).toMatchObject({ valid: false, status: 'AUTH_REQUIRED' });
    expect(status.canRetry).toBeUndefined();
  });
});

describe('getAuthenticatedClient transient-refresh mapping', () => {
  let cleanupDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (cleanupDir) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  /** Initializes the account-module singleton so getAuthenticatedClient can resolve it. */
  async function initModule() {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-get-client-transient-'));
    const accountsPath = path.join(cleanupDir, 'accounts.json');
    const credentialsPath = path.join(cleanupDir, 'credentials');
    fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      accountsPath,
      JSON.stringify({ accounts: [{ email: 'user@example.com', category: 'work', description: 'User' }] }),
    );
    vi.stubEnv('ACCOUNTS_PATH', accountsPath);
    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
    vi.resetModules();

    const accounts = await import('../src/modules/accounts/index.js');
    const manager = await accounts.initializeAccountModule();
    const base = await import('../src/services/base/BaseGoogleService.js');
    return { manager, base };
  }

  /** Minimal concrete subclass exposing the protected getAuthenticatedClient. */
  function makeService(base: typeof import('../src/services/base/BaseGoogleService.js')) {
    class TestService extends base.BaseGoogleService<{ ok: true }> {
      constructor() {
        super({ serviceName: 'gmail', version: 'v1' });
        // Skip the real OAuth bootstrap — getAuthenticatedClient only needs a truthy client.
        (this as unknown as { oauth2Client: unknown }).oauth2Client = { setCredentials() {} };
      }
      run(email: string) {
        return this.getAuthenticatedClient(email, () => ({ ok: true as const }));
      }
    }
    return new TestService();
  }

  it('maps a canRetry validateToken result to a temporary (non-reconnect) error', async () => {
    const { manager, base } = await initModule();
    vi.spyOn(manager, 'validateToken').mockResolvedValue({
      valid: false,
      status: 'REFRESH_FAILED',
      reason: 'Token refresh failed, temporary error',
      canRetry: true,
    });

    const service = makeService(base);
    await expect(service.run('user@example.com')).rejects.toMatchObject({
      // handleError re-wraps the AccountError('TEMPORARY_AUTH_ERROR') into a GoogleServiceError;
      // the important guarantee is it is NOT the AUTH_REQUIRED/reconnect shape.
      data: { code: 'HTTP_TEMPORARY_AUTH_ERROR', details: expect.stringMatching(/temporarily/i) },
    });
  });

  it('still maps a non-retryable invalid grant to AUTH_REQUIRED (regression guard)', async () => {
    const { manager, base } = await initModule();
    vi.spyOn(manager, 'validateToken').mockResolvedValue({
      valid: false,
      status: 'AUTH_REQUIRED',
      reason: 'Refresh token is invalid or revoked',
    });

    const service = makeService(base);
    await expect(service.run('user@example.com')).rejects.toMatchObject({
      data: { code: 'HTTP_AUTH_REQUIRED' },
    });
  });
});
