import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('account slug collision detection', () => {
  let cleanupDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (cleanupDir) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  it('skips colliding accounts and keeps the non-colliding subset registered', async () => {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-collision-'));
    const accountsPath = path.join(cleanupDir, 'accounts.json');
    const credentialsPath = path.join(cleanupDir, 'credentials');
    fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      accountsPath,
      JSON.stringify({
        accounts: [
          { email: 'a+b@example.com', category: 'work', description: 'Collision A' },
          { email: 'a-b@example.com', category: 'work', description: 'Collision B' },
          { email: 'ok@example.com', category: 'work', description: 'OK' },
        ],
      }),
    );

    vi.stubEnv('ACCOUNTS_PATH', accountsPath);
    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
    vi.resetModules();

    const { AccountManager } = await import('../src/modules/accounts/manager.js');
    const manager = new AccountManager();
    await manager.initialize();

    const accounts = await manager.listAccounts();
    expect(accounts.map(account => account.email)).toEqual(['ok@example.com']);
  });
});
