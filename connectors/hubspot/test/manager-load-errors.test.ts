import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAccountManagerForTests,
  getAccountManager,
  sanitizeEmail,
  TokenFileCorruptError,
  TokenFileMissingError,
  TokenFilePermissionDeniedError,
} from '../src/modules/accounts/manager.js';

const TEST_EMAIL = 'test@example.com';

function createConfigDir(prefix: string): string {
  const configDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  return configDir;
}

function tokenPathFor(configDir: string, email = TEST_EMAIL): string {
  return join(configDir, 'credentials', `${sanitizeEmail(email)}.token.json`);
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetAccountManagerForTests();
  delete process.env.HUBSPOT_CONFIG_DIR;
});

describe('AccountManager.loadToken error mapping', () => {
  it('throws TokenFileMissingError for missing files', async () => {
    const configDir = createConfigDir('hubspot-load-errors-missing-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    const manager = getAccountManager();
    await expect(manager.loadToken(TEST_EMAIL)).rejects.toBeInstanceOf(TokenFileMissingError);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('throws TokenFileCorruptError for invalid JSON', async () => {
    const configDir = createConfigDir('hubspot-load-errors-corrupt-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    writeFileSync(tokenPathFor(configDir), '{this-is-not-json');
    const manager = getAccountManager();
    await expect(manager.loadToken(TEST_EMAIL)).rejects.toBeInstanceOf(TokenFileCorruptError);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('throws TokenFilePermissionDeniedError for EACCES/EPERM reads', async () => {
    const configDir = createConfigDir('hubspot-load-errors-permission-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );

    const manager = getAccountManager();
    await expect(manager.loadToken(TEST_EMAIL)).rejects.toBeInstanceOf(TokenFilePermissionDeniedError);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('keeps TokenFileError cause non-enumerable in JSON output', () => {
    const error = new TokenFilePermissionDeniedError(
      '/tmp/credential.token.json',
      new Error('refresh_token=secret'),
    );

    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('cause');
    expect(serialized).not.toContain('refresh_token=secret');
  });
});
