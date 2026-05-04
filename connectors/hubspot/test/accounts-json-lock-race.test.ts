import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetAccountManagerForTests,
  getAccountManager,
  sanitizeEmail,
  type TokenData,
} from '../src/modules/accounts/manager.js';

function createConfigDir(prefix: string): string {
  const configDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  return configDir;
}

function tokenPathFor(configDir: string, email: string): string {
  return join(configDir, 'credentials', `${sanitizeEmail(email)}.token.json`);
}

function makeToken(email: string, suffix: string, hubId: number): TokenData {
  return {
    access_token: `access-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    expires_at: Date.now() + 60_000,
    hub_id: hubId,
    user: email,
    schemaVersion: 1,
  };
}

afterEach(() => {
  __resetAccountManagerForTests();
  delete process.env.HUBSPOT_CONFIG_DIR;
});

describe('accounts.json lock regression', () => {
  it('preserves both accounts when two saveToken calls for different emails start in the same tick', async () => {
    const configDir = createConfigDir('hubspot-accounts-lock-race-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    writeFileSync(
      join(configDir, 'accounts.json'),
      JSON.stringify({ accounts: [] }, null, 2),
    );

    const emailA = 'alpha@example.com';
    const emailB = 'beta@example.com';
    const manager = getAccountManager();

    await Promise.all([
      Promise.resolve().then(() => manager.saveToken(emailA, makeToken(emailA, 'a', 101))),
      Promise.resolve().then(() => manager.saveToken(emailB, makeToken(emailB, 'b', 202))),
    ]);

    const accountsRaw = JSON.parse(readFileSync(join(configDir, 'accounts.json'), 'utf-8')) as {
      accounts?: Array<{ email: string; hubId: number }>;
    };
    const persistedEmails = (accountsRaw.accounts ?? []).map((account) => account.email).sort();
    expect(persistedEmails).toEqual([emailA, emailB].sort());

    const tokenA = JSON.parse(readFileSync(tokenPathFor(configDir, emailA), 'utf-8')) as { access_token: string };
    const tokenB = JSON.parse(readFileSync(tokenPathFor(configDir, emailB), 'utf-8')) as { access_token: string };
    expect(tokenA.access_token).toBe('access-a');
    expect(tokenB.access_token).toBe('access-b');

    rmSync(configDir, { recursive: true, force: true });
  });
});
