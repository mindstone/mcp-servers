import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetAccountManagerForTests,
  getAccountManager,
  sanitizeEmail,
  TokenFileFutureSchemaError,
} from '../src/modules/accounts/manager.js';

const TEST_EMAIL = 'schema@example.com';

function createConfigDir(prefix: string): string {
  const configDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  return configDir;
}

function tokenPathFor(configDir: string, email = TEST_EMAIL): string {
  return join(configDir, 'credentials', `${sanitizeEmail(email)}.token.json`);
}

afterEach(() => {
  __resetAccountManagerForTests();
  delete process.env.HUBSPOT_CONFIG_DIR;
});

describe('AccountManager token schema versioning', () => {
  it('normalizes v0 token files (missing schemaVersion) in-memory without write-back on read', async () => {
    const configDir = createConfigDir('hubspot-schema-migrate-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    writeFileSync(
      tokenPathFor(configDir),
      JSON.stringify({
        access_token: 'legacy-access-token',
        refresh_token: 'legacy-refresh-token',
        expires_at: Date.now() + 60_000,
        hub_id: 123456,
        user: TEST_EMAIL,
      }, null, 2),
    );

    const manager = getAccountManager();
    const token = await manager.loadToken(TEST_EMAIL);

    expect(token.schemaVersion).toBe(1);
    const persisted = JSON.parse(readFileSync(tokenPathFor(configDir), 'utf-8')) as { schemaVersion?: number };
    expect(persisted.schemaVersion).toBeUndefined();

    rmSync(configDir, { recursive: true, force: true });
  });

  it('throws TokenFileFutureSchemaError for unsupported future schema versions', async () => {
    const configDir = createConfigDir('hubspot-schema-future-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    writeFileSync(
      tokenPathFor(configDir),
      JSON.stringify({
        access_token: 'future-access-token',
        refresh_token: 'future-refresh-token',
        expires_at: Date.now() + 60_000,
        schemaVersion: 999,
      }, null, 2),
    );

    const manager = getAccountManager();
    await expect(manager.loadToken(TEST_EMAIL)).rejects.toBeInstanceOf(TokenFileFutureSchemaError);

    rmSync(configDir, { recursive: true, force: true });
  });
});
