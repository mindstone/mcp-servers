import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for the transient-refresh reporting path: `list_workspace_accounts`
 * must not report an account as disconnected on a *transient* refresh failure.
 *
 * `autoRenewToken` already distinguishes a temporary network blip (`canRetry: true`) from a
 * revoked/invalid grant (`canRetry: false`), but `listAccounts` used to collapse both into
 * `auth_status.valid: false`. An agent keying off that boolean would then wrongly tell the user
 * to reconnect an account whose grant is actually fine. The fix reports the transient case as
 * `valid: true` (reconnect not required), mirroring `withTokenRenewal`.
 *
 * These tests drive the account manager's own `GoogleOAuthClient.refreshToken` via a spy — the
 * same injection style as `disable-refresh.test.ts` — so the assertions don't depend on gaxios
 * error-message formatting. The spy branches on the refresh-token value so multiple accounts can
 * fail in different ways within one manager.
 */
describe('list_workspace_accounts refresh-failure status mapping', () => {
  let cleanupDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    if (cleanupDir) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  interface AccountSpec {
    email: string;
    description: string;
    /** Refresh-token value written to the credential file; omit to write no token file at all. */
    refreshToken?: string;
  }

  /**
   * Seeds accounts + credentials, installs a `refreshToken` spy that rejects based on the
   * refresh-token value (per `refreshByToken`), and returns the initialized manager.
   */
  async function initManager(
    prefix: string,
    specs: AccountSpec[],
    refreshByToken: (refreshToken: string) => Promise<never>,
  ) {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const accountsPath = path.join(cleanupDir, 'accounts.json');
    const credentialsPath = path.join(cleanupDir, 'credentials');
    fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      accountsPath,
      JSON.stringify({
        accounts: specs.map((s) => ({ email: s.email, category: 'work', description: s.description })),
      }),
    );
    for (const spec of specs) {
      if (spec.refreshToken === undefined) continue; // NO_TOKEN case: leave the token file absent
      const slug = spec.email.replace(/[@.]/g, '-');
      // Expired access token with a refresh token present -> autoRenewToken attempts a refresh.
      fs.writeFileSync(
        path.join(credentialsPath, `${slug}.token.json`),
        JSON.stringify({
          access_token: 'expired-access-token',
          refresh_token: spec.refreshToken,
          expiry_date: Date.now() - 60_000,
        }),
        { mode: 0o600 },
      );
    }

    vi.stubEnv('ACCOUNTS_PATH', accountsPath);
    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
    vi.resetModules();

    const { GoogleOAuthClient } = await import('../src/modules/accounts/oauth.js');
    vi.spyOn(GoogleOAuthClient.prototype, 'refreshToken').mockImplementation((rt: string) =>
      refreshByToken(rt),
    );

    const { initializeAccountModule } = await import('../src/modules/accounts/index.js');
    return initializeAccountModule();
  }

  const rejectTransient = () => Promise.reject(new Error('temporarily unavailable'));
  const rejectInvalidGrant = () => Promise.reject(new Error('invalid_grant'));

  it('reports a transient refresh failure as valid (no reconnect required)', async () => {
    // Non-invalid_grant error on every attempt -> autoRenewToken exhausts its retry and
    // returns REFRESH_FAILED with canRetry: true.
    const manager = await initManager(
      'gw-transient-refresh-',
      [{ email: 'user@example.com', description: 'User', refreshToken: 'transient-token' }],
      rejectTransient,
    );

    const accounts = await manager.listAccounts();

    expect(accounts).toHaveLength(1);
    expect(accounts[0].auth_status).toMatchObject({
      valid: true,
      status: 'REFRESH_FAILED',
    });
    expect(accounts[0].auth_status?.reason).toMatch(/temporary/i);
  });

  it('promotes a transient-only account over a revoked one when picking the default', async () => {
    // First account is revoked (valid:false); second is a transient blip (valid:true). The default
    // must flip to the second account. Before the fix both were valid:false, so the handler fell
    // back to index 0 (the revoked account) — this asserts the fix actually changes selection.
    await initManager(
      'gw-default-selection-',
      [
        { email: 'revoked@example.com', description: 'Revoked', refreshToken: 'revoked-token' },
        { email: 'transient@example.com', description: 'Transient', refreshToken: 'transient-token' },
      ],
      (rt) => (rt === 'revoked-token' ? rejectInvalidGrant() : rejectTransient()),
    );

    const { handleListWorkspaceAccounts } = await import('../src/tools/account-handlers.js');
    const response = await handleListWorkspaceAccounts();
    const payload = JSON.parse((response.content[0] as { text: string }).text);

    const revoked = payload.accounts.find((a: { email: string }) => a.email === 'revoked@example.com');
    const transient = payload.accounts.find((a: { email: string }) => a.email === 'transient@example.com');

    expect(revoked.auth_status.valid).toBe(false);
    expect(transient.auth_status.valid).toBe(true);
    expect(revoked.is_default).toBe(false);
    expect(transient.is_default).toBe(true);
    expect(payload.default_package_id).toBe(transient.package_id);
  });

  it('still reports an invalid/revoked grant as disconnected (regression guard)', async () => {
    // invalid_grant is detected on the first attempt -> AUTH_REQUIRED, valid: false.
    const manager = await initManager(
      'gw-invalid-grant-list-',
      [{ email: 'user@example.com', description: 'User', refreshToken: 'revoked-token' }],
      rejectInvalidGrant,
    );

    const accounts = await manager.listAccounts();

    expect(accounts).toHaveLength(1);
    expect(accounts[0].auth_status).toMatchObject({
      valid: false,
      status: 'AUTH_REQUIRED',
    });
  });

  it('reports a missing token as disconnected (non-retryable NO_TOKEN branch)', async () => {
    // No credential file -> autoRenewToken returns NO_TOKEN, which must stay valid: false.
    const manager = await initManager(
      'gw-no-token-',
      [{ email: 'user@example.com', description: 'User' }],
      rejectTransient, // never called; no token file means no refresh attempt
    );

    const accounts = await manager.listAccounts();

    expect(accounts).toHaveLength(1);
    expect(accounts[0].auth_status).toMatchObject({
      valid: false,
      status: 'NO_TOKEN',
    });
  });
});
