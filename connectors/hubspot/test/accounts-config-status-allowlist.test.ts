import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAccountManagerForTests,
  getAccountManager,
  type StoredAccountRecord,
} from '../src/modules/accounts/manager.js';
import logger from '../src/utils/logger.js';

const TEST_TELEMETRY_SALT_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function createConfigDir(prefix: string): string {
  const configDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  return configDir;
}

function writeAccounts(
  configDir: string,
  accounts: Array<{ email: string; hubId: number; status?: unknown }>,
): void {
  writeFileSync(join(configDir, 'accounts.json'), JSON.stringify({ accounts }));
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

describe('accounts.json status allowlist hardening', () => {
  it.each([
    ['null', null],
    ['false', false],
    ['number', 42],
    ['object', {}],
  ])(
    'coerces present non-string status %s to error and blocks configured-account auth',
    async (_label, unknownStatus) => {
      const configDir = createConfigDir('hubspot-accounts-status-unknown-');
      const email = 'unknown-status@example.com';
      process.env.HUBSPOT_CONFIG_DIR = configDir;
      process.env.HUBSPOT_ACCOUNT_EMAIL = email;
      process.env.HUBSPOT_TELEMETRY_SALT = TEST_TELEMETRY_SALT_HEX;
      writeAccounts(configDir, [{ email, hubId: 11, status: unknownStatus }]);
      __resetAccountManagerForTests();

      const warnSpy = vi.spyOn(logger, 'warn');

      const config = await readAccountsConfig();
      expect(config.accounts).toEqual([
        expect.objectContaining({
          email,
          hubId: 11,
          status: 'error',
        }),
      ]);
      await expect(getAccountManager().hasConfiguredAccountEmail()).resolves.toBe(false);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          unknownStatus,
          email: expect.any(String),
        }),
        'accounts_config_unknown_status_treated_as_error',
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(email);

      rmSync(configDir, { recursive: true, force: true });
    },
  );

  it('keeps undefined status unchanged and does not warn', async () => {
    const configDir = createConfigDir('hubspot-accounts-status-undefined-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_TELEMETRY_SALT = TEST_TELEMETRY_SALT_HEX;
    writeAccounts(configDir, [{ email: 'no-status@example.com', hubId: 22 }]);
    __resetAccountManagerForTests();

    const warnSpy = vi.spyOn(logger, 'warn');

    const config = await readAccountsConfig();
    expect(config.accounts).toEqual([
      expect.objectContaining({
        email: 'no-status@example.com',
        hubId: 22,
      }),
    ]);
    expect(config.accounts[0]?.status).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();

    rmSync(configDir, { recursive: true, force: true });
  });

  it('preserves explicit error status without warning', async () => {
    const configDir = createConfigDir('hubspot-accounts-status-error-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_TELEMETRY_SALT = TEST_TELEMETRY_SALT_HEX;
    writeAccounts(configDir, [{ email: 'error-status@example.com', hubId: 33, status: 'error' }]);
    __resetAccountManagerForTests();

    const warnSpy = vi.spyOn(logger, 'warn');

    const config = await readAccountsConfig();
    expect(config.accounts).toEqual([
      expect.objectContaining({
        email: 'error-status@example.com',
        hubId: 33,
        status: 'error',
      }),
    ]);
    expect(warnSpy).not.toHaveBeenCalled();

    rmSync(configDir, { recursive: true, force: true });
  });
});
