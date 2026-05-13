import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAccountManagerForTests,
  getAccountManager,
  sanitizeEmail,
  TokenFileMismatchError,
  type StoredAccountRecord,
} from '../src/modules/accounts/manager.js';
import logger from '../src/utils/logger.js';

const TEST_TELEMETRY_SALT_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function createConfigDir(prefix: string): string {
  const configDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  return configDir;
}

function writeAccounts(configDir: string, emails: string[]): void {
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({
      accounts: emails.map((email, index) => ({ email, hubId: index + 1 })),
    }),
  );
}

async function readAccountsConfig(): Promise<{ accounts: StoredAccountRecord[] }> {
  const manager = getAccountManager() as unknown as {
    readAccountsConfig(): Promise<{ accounts: StoredAccountRecord[] }>;
  };
  return manager.readAccountsConfig();
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetAccountManagerForTests();
  delete process.env.HUBSPOT_CONFIG_DIR;
  delete process.env.HUBSPOT_ACCOUNT_EMAIL;
  delete process.env.HUBSPOT_TELEMETRY_SALT;
});

describe('sanitizeEmail collision hardening', () => {
  it.each([
    ['dot-vs-hyphen', ['a.b@x.com', 'a-b@x.com']],
    ['underscore-vs-hyphen', ['a_b@x.com', 'a-b@x.com']],
    ['plus-vs-hyphen', ['a+b@x.com', 'a-b@x.com']],
    ['mixed-case-only-difference', ['Case@x.com', 'case@x.com']],
  ])('marks colliding accounts as error for %s', async (_name, emails) => {
    const configDir = createConfigDir('hubspot-c3-collision-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_TELEMETRY_SALT = TEST_TELEMETRY_SALT_HEX;
    writeAccounts(configDir, emails);
    __resetAccountManagerForTests();
    const errorSpy = vi.spyOn(logger, 'error');

    const config = await readAccountsConfig();

    expect(config.accounts.map((account) => account.status)).toEqual(['error', 'error']);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ collisionHash: expect.any(String) }),
      'sanitize_email_collision',
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(emails[0]);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(emails[1]);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('shows colliding accounts as error without reading their token files', async () => {
    const configDir = createConfigDir('hubspot-c3-get-accounts-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_TELEMETRY_SALT = TEST_TELEMETRY_SALT_HEX;
    writeAccounts(configDir, ['a.b@x.com', 'a-b@x.com']);
    __resetAccountManagerForTests();

    const accounts = await getAccountManager().getAccounts();

    expect(accounts).toEqual([
      expect.objectContaining({ email: 'a.b@x.com', status: 'error' }),
      expect.objectContaining({ email: 'a-b@x.com', status: 'error' }),
    ]);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('rejects configured account selection when the selected account is in collision error state', async () => {
    const configDir = createConfigDir('hubspot-c3-configured-selection-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_TELEMETRY_SALT = TEST_TELEMETRY_SALT_HEX;
    process.env.HUBSPOT_ACCOUNT_EMAIL = 'a.b@x.com';
    writeAccounts(configDir, ['a.b@x.com', 'a-b@x.com']);
    __resetAccountManagerForTests();

    await expect(getAccountManager().hasConfiguredAccountEmail()).resolves.toBe(false);
    await expect(getAccountManager().getCurrentAccountEmail()).rejects.toThrow(
      'Configured account has a sanitiser collision and is unavailable; remove or rename one of the colliding accounts.',
    );

    rmSync(configDir, { recursive: true, force: true });
  });

  it('re-reads accounts.json when an external write changes the file', async () => {
    const configDir = createConfigDir('hubspot-c3-cache-mtime-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    writeAccounts(configDir, ['first@example.com']);
    __resetAccountManagerForTests();

    const manager = getAccountManager() as unknown as {
      readAccountsConfig(): Promise<{ accounts: StoredAccountRecord[] }>;
    };

    const firstRead = await manager.readAccountsConfig();
    expect(firstRead.accounts.map((account) => account.email)).toEqual(['first@example.com']);

    writeFileSync(
      join(configDir, 'accounts.json'),
      JSON.stringify({
        accounts: [{ email: 'second@example.com', hubId: 303 }],
      }),
    );

    const secondRead = await manager.readAccountsConfig();
    expect(secondRead.accounts).toEqual([
      expect.objectContaining({ email: 'second@example.com', hubId: 303 }),
    ]);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('drops cached accounts when accounts.json is externally deleted', async () => {
    const configDir = createConfigDir('hubspot-c3-cache-enoent-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    writeAccounts(configDir, ['first@example.com']);
    __resetAccountManagerForTests();

    const manager = getAccountManager() as unknown as {
      readAccountsConfig(): Promise<{ accounts: StoredAccountRecord[] }>;
    };

    const firstRead = await manager.readAccountsConfig();
    expect(firstRead.accounts.map((account) => account.email)).toEqual(['first@example.com']);

    rmSync(join(configDir, 'accounts.json'), { force: true });

    const secondRead = await manager.readAccountsConfig();
    expect(secondRead.accounts).toEqual([]);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('preserves persisted status from accounts.json and enforces configured-account auth gate', async () => {
    const configDir = createConfigDir('hubspot-c3-persisted-status-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_ACCOUNT_EMAIL = 'persisted-error@example.com';
    writeFileSync(
      join(configDir, 'accounts.json'),
      JSON.stringify({
        accounts: [{ email: 'persisted-error@example.com', hubId: 44, status: 'error' }],
      }),
    );
    __resetAccountManagerForTests();

    const manager = getAccountManager() as unknown as {
      readAccountsConfig(): Promise<{ accounts: StoredAccountRecord[] }>;
    };

    const config = await manager.readAccountsConfig();
    expect(config.accounts).toEqual([
      expect.objectContaining({
        email: 'persisted-error@example.com',
        hubId: 44,
        status: 'error',
      }),
    ]);
    await expect(getAccountManager().hasConfiguredAccountEmail()).resolves.toBe(false);
    await expect(getAccountManager().getCurrentAccountEmail()).rejects.toThrow(
      'Configured account has a sanitiser collision and is unavailable; remove or rename one of the colliding accounts.',
    );

    rmSync(configDir, { recursive: true, force: true });
  });

  it('rejects token files whose embedded user belongs to a different account', async () => {
    const configDir = createConfigDir('hubspot-c3-token-mismatch-');
    const requestedEmail = 'a-b@x.com';
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, 'credentials', `${sanitizeEmail(requestedEmail)}.token.json`),
      JSON.stringify({
        access_token: 'wrong-account-access-token',
        refresh_token: 'wrong-account-refresh-token',
        expires_at: Date.now() + 86_400_000,
        hub_id: 123,
        user: 'a.b@x.com',
        schemaVersion: 1,
      }),
    );
    __resetAccountManagerForTests();

    await expect(getAccountManager().loadToken(requestedEmail)).rejects.toBeInstanceOf(TokenFileMismatchError);

    rmSync(configDir, { recursive: true, force: true });
  });
});
