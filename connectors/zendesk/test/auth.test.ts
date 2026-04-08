import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Auth — loadAccounts and account resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendesk-auth-test-'));
    vi.stubEnv('ZENDESK_CONFIG_PATH', tempDir);
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.stubEnv('MINDSTONE_REBEL_BRIDGE_STATE', '');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('should load accounts from valid accounts.json', async () => {
    const accountsJson = {
      accounts: [
        { subdomain: 'testcorp', email: 'agent@testcorp.com', apiToken: 'tok-123' },
      ],
      defaultSubdomain: 'testcorp',
    };
    fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify(accountsJson));

    const auth = await import('../src/auth.js');
    // loadAccounts() is called at module load, so accounts should already be loaded
    const config = auth.getAccountsConfig();
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0].subdomain).toBe('testcorp');
    expect(config.defaultSubdomain).toBe('testcorp');
  });

  it('should handle missing accounts.json gracefully', async () => {
    // No accounts.json in tempDir
    const auth = await import('../src/auth.js');
    const config = auth.getAccountsConfig();
    expect(config.accounts).toHaveLength(0);
  });

  it('should handle malformed JSON in accounts.json', async () => {
    fs.writeFileSync(path.join(tempDir, 'accounts.json'), '{ not valid json !!!');

    const auth = await import('../src/auth.js');
    const config = auth.getAccountsConfig();
    expect(config.accounts).toHaveLength(0);
  });

  it('should handle accounts.json with missing accounts array', async () => {
    fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify({ foo: 'bar' }));

    const auth = await import('../src/auth.js');
    const config = auth.getAccountsConfig();
    expect(config.accounts).toHaveLength(0);
  });

  it('should load OAuth credential files from credentials directory', async () => {
    const tokenData = {
      access_token: 'oauth-access-123',
      refresh_token: 'oauth-refresh-456',
      expires_in: 7200,
      expires_at: Date.now() + 7200_000,
      token_type: 'bearer',
      subdomain: 'oauthcorp',
      email: 'agent@oauthcorp.com',
    };
    const credDir = path.join(tempDir, 'credentials');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, 'oauthcorp.token.json'), JSON.stringify(tokenData));

    const auth = await import('../src/auth.js');
    const config = auth.getAccountsConfig();
    // OAuth account should be added to accounts list
    expect(config.accounts.some(a => a.subdomain === 'oauthcorp')).toBe(true);
  });

  it('should resolve getAccount with explicit subdomain', async () => {
    const accountsJson = {
      accounts: [
        { subdomain: 'corp-a', email: 'a@test.com', apiToken: 'tok-a' },
        { subdomain: 'corp-b', email: 'b@test.com', apiToken: 'tok-b' },
      ],
      defaultSubdomain: 'corp-a',
    };
    fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify(accountsJson));

    const auth = await import('../src/auth.js');
    const account = await auth.getAccount('corp-b');
    expect(account).toBeDefined();
    expect(account!.subdomain).toBe('corp-b');
  });

  it('should resolve getAccount with default subdomain when none specified', async () => {
    const accountsJson = {
      accounts: [
        { subdomain: 'corp-a', email: 'a@test.com', apiToken: 'tok-a' },
        { subdomain: 'corp-b', email: 'b@test.com', apiToken: 'tok-b' },
      ],
      defaultSubdomain: 'corp-a',
    };
    fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify(accountsJson));

    const auth = await import('../src/auth.js');
    const account = await auth.getAccount();
    expect(account).toBeDefined();
    expect(account!.subdomain).toBe('corp-a');
  });

  it('should return undefined when no accounts exist', async () => {
    const auth = await import('../src/auth.js');
    const account = await auth.getAccount();
    expect(account).toBeUndefined();
  });

  it('should respect ZENDESK_CONFIG_PATH env var', async () => {
    const auth = await import('../src/auth.js');
    expect(auth.CONFIG_PATH).toBe(tempDir);
  });

  it('should save token files with 0o600 permissions', async () => {
    const auth = await import('../src/auth.js');
    const tokenData = {
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      expires_in: 7200,
      expires_at: Date.now() + 7200_000,
      token_type: 'bearer',
      subdomain: 'permtest',
      email: 'test@perm.com',
    };
    auth.saveToken('permtest', tokenData);

    const tokenPath = path.join(tempDir, 'credentials', 'permtest.token.json');
    expect(fs.existsSync(tokenPath)).toBe(true);
    const stats = fs.statSync(tokenPath);
    // Check that only owner has read/write (0o600)
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('should create credentials directory with 0o700 permissions', async () => {
    const auth = await import('../src/auth.js');
    auth.saveToken('permtest', {
      access_token: 'x',
      expires_in: 7200,
      expires_at: Date.now() + 7200_000,
      token_type: 'bearer',
      subdomain: 'permtest',
    });

    const credDir = path.join(tempDir, 'credentials');
    const stats = fs.statSync(credDir);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('should remove account and persist to disk', async () => {
    const accountsJson = {
      accounts: [
        { subdomain: 'removeme', email: 'remove@test.com', apiToken: 'tok-rem' },
        { subdomain: 'keepme', email: 'keep@test.com', apiToken: 'tok-keep' },
      ],
      defaultSubdomain: 'removeme',
    };
    fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify(accountsJson));

    const auth = await import('../src/auth.js');
    auth.removeAccount('removeme');
    const config = auth.getAccountsConfig();
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0].subdomain).toBe('keepme');
    // Default should shift to remaining account
    expect(config.defaultSubdomain).toBe('keepme');

    // Verify persisted to disk
    const diskData = JSON.parse(fs.readFileSync(path.join(tempDir, 'accounts.json'), 'utf8'));
    expect(diskData.accounts).toHaveLength(1);
  });
});
