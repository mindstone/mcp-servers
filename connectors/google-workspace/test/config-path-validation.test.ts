import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('account and credential path validation', () => {
  let cleanupDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (cleanupDir) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  function makeTempDir(prefix: string) {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return cleanupDir;
  }

  it('rejects ACCOUNTS_PATH when it points to a symlink', async () => {
    const dir = makeTempDir('google-workspace-accounts-symlink-');
    const realFile = path.join(dir, 'accounts-real.json');
    const symlink = path.join(dir, 'accounts.json');
    fs.writeFileSync(realFile, JSON.stringify({ accounts: [] }));
    fs.symlinkSync(realFile, symlink);

    vi.stubEnv('ACCOUNTS_PATH', symlink);
    vi.resetModules();
    const { AccountManager } = await import('../src/modules/accounts/manager.js');

    expect(() => new AccountManager()).toThrow(/ACCOUNTS_PATH/);
  });

  it('rejects ACCOUNTS_PATH when it does not exist', async () => {
    const dir = makeTempDir('google-workspace-accounts-missing-');
    vi.stubEnv('ACCOUNTS_PATH', path.join(dir, 'missing.json'));
    vi.resetModules();
    const { AccountManager } = await import('../src/modules/accounts/manager.js');

    expect(() => new AccountManager()).toThrow(/ACCOUNTS_PATH/);
  });

  it('rejects CREDENTIALS_PATH when it points to a symlink', async () => {
    const dir = makeTempDir('google-workspace-credentials-symlink-');
    const realDir = path.join(dir, 'credentials-real');
    const symlink = path.join(dir, 'credentials');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, symlink);

    vi.stubEnv('CREDENTIALS_PATH', symlink);
    vi.resetModules();
    const { TokenManager } = await import('../src/modules/accounts/token.js');

    expect(() => new TokenManager()).toThrow(/CREDENTIALS_PATH/);
  });

  it('rejects CREDENTIALS_PATH when it does not exist', async () => {
    const dir = makeTempDir('google-workspace-credentials-missing-');
    vi.stubEnv('CREDENTIALS_PATH', path.join(dir, 'missing'));
    vi.resetModules();
    const { TokenManager } = await import('../src/modules/accounts/token.js');

    expect(() => new TokenManager()).toThrow(/CREDENTIALS_PATH/);
  });
});
