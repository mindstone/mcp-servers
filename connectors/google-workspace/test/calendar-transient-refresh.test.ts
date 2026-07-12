import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Handler-level regression coverage for the calendar module's transient-refresh handling.
 *
 * The calendar module does not go through `BaseGoogleService`; it has its own `getCalendarClient`
 * (validate-then-throw) and `handleCalendarOperation` (401/403 recovery). Both used to fall through
 * to a hard `AUTH_REQUIRED` / raw 401 when `validateToken` reported a transient blip
 * (`{ valid: false, canRetry: true }`), so a live grant surfaced the reconnect CTA.
 *
 * The fix mirrors `withTokenRenewal`: a `canRetry` result maps to a retryable `TEMPORARY_AUTH_ERROR`
 * rather than an `AUTH_REQUIRED` reconnect demand. `formatErrorResponse` (server.ts) only emits the
 * reconnect CTA for `AccountError.code === 'AUTH_REQUIRED'` or a numeric 401, so `TEMPORARY_AUTH_ERROR`
 * (whether wrapped as `CalendarError` or `AccountError`) routes to the generic retry path instead.
 */
describe('calendar module transient-refresh mapping', () => {
  let cleanupDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (cleanupDir) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  /** Initializes the account-module singleton so getAccountManager() resolves inside the service. */
  async function initModule() {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-calendar-transient-'));
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
    const calendar = await import('../src/modules/calendar/service.js');
    const types = await import('../src/modules/calendar/types.js');
    return { manager, calendar, types };
  }

  /** Builds a CalendarService that skips the real OAuth bootstrap. */
  function makeService(calendar: typeof import('../src/modules/calendar/service.js')) {
    const service = new calendar.CalendarService();
    // The token gates only need a truthy client with setCredentials; skip initialize().
    Object.assign(service as unknown as Record<string, unknown>, {
      initialized: true,
      oauth2Client: { setCredentials() {} },
    });
    return service;
  }

  it('getCalendarClient maps a canRetry validateToken result to a temporary (non-reconnect) error', async () => {
    const { manager, calendar } = await initModule();
    vi.spyOn(manager, 'validateToken').mockResolvedValue({
      valid: false,
      status: 'REFRESH_FAILED',
      reason: 'Token refresh failed, temporary error',
      canRetry: true,
    });

    const service = makeService(calendar);
    // getCalendarClient is private; invoke it directly to isolate the token gate.
    const run = (service as unknown as { getCalendarClient(email: string): Promise<unknown> })
      .getCalendarClient('user@example.com');

    // Must NOT be AUTH_REQUIRED — that is the code that routes to the reconnect CTA.
    await expect(run).rejects.toMatchObject({ code: 'TEMPORARY_AUTH_ERROR' });
  });

  it('getCalendarClient still maps a non-retryable invalid grant to AUTH_REQUIRED (regression guard)', async () => {
    const { manager, calendar } = await initModule();
    vi.spyOn(manager, 'validateToken').mockResolvedValue({
      valid: false,
      status: 'AUTH_REQUIRED',
      reason: 'Refresh token is invalid or revoked',
    });

    const service = makeService(calendar);
    const run = (service as unknown as { getCalendarClient(email: string): Promise<unknown> })
      .getCalendarClient('user@example.com');

    await expect(run).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('handleCalendarOperation maps a canRetry result on 401 recovery to a temporary (non-reconnect) error', async () => {
    const { manager, calendar } = await initModule();
    // The operation fails with a 401 → isUnauthorizedError → validateToken re-check returns a
    // transient blip. Old behaviour rethrew the raw 401 (→ reconnect CTA); the fix throws
    // TEMPORARY_AUTH_ERROR (retryable, generic path).
    vi.spyOn(manager, 'validateToken').mockResolvedValue({
      valid: false,
      status: 'REFRESH_FAILED',
      reason: 'Token refresh failed, temporary error',
      canRetry: true,
    });

    const service = makeService(calendar);
    const run = (service as unknown as {
      handleCalendarOperation<T>(email: string, op: () => Promise<T>): Promise<T>;
    }).handleCalendarOperation('user@example.com', async () => {
      throw { status: 401, message: 'Unauthorized' };
    });

    await expect(run).rejects.toMatchObject({ code: 'TEMPORARY_AUTH_ERROR' });
  });

  it('handleCalendarOperation still surfaces the raw 401 when the grant is a dead grant (regression guard)', async () => {
    const { manager, calendar } = await initModule();
    // A dead grant returns AUTH_REQUIRED with no canRetry, so the 401-recovery leg falls through
    // to the raw 401 → formatErrorResponse emits the reconnect CTA (unchanged behaviour).
    vi.spyOn(manager, 'validateToken').mockResolvedValue({
      valid: false,
      status: 'AUTH_REQUIRED',
      reason: 'Refresh token is invalid or revoked',
    });

    const service = makeService(calendar);
    const run = (service as unknown as {
      handleCalendarOperation<T>(email: string, op: () => Promise<T>): Promise<T>;
    }).handleCalendarOperation('user@example.com', async () => {
      throw { status: 401, message: 'Unauthorized' };
    });

    await expect(run).rejects.toMatchObject({ status: 401 });
  });
});
