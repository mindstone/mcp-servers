import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MicrosoftRefreshDisabledError, TokenProvider } from '../src/tokenProvider.js';

const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

function makeConfigDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTokenFile(configDir: string, email: string, token: Record<string, unknown>): string {
  const sanitised = email.replace(/[^a-zA-Z0-9]/g, '-');
  const credentialsDir = path.join(configDir, 'credentials');
  fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(credentialsDir, `${sanitised}.token.json`);
  fs.writeFileSync(tokenPath, JSON.stringify(token), { mode: 0o600 });
  return tokenPath;
}

function writeAccountsFile(configDir: string, accounts: Array<{ email: string; displayName?: string }>): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(configDir, 'accounts.json'),
    JSON.stringify({ accounts }),
    { mode: 0o600 },
  );
}

describe('TokenProvider — happy path', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = makeConfigDir('microsoft-shared-happy-');
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns the access token from a per-account file when not expired', async () => {
    writeAccountsFile(configDir, [{ email: 'user@example.com' }]);
    writeTokenFile(configDir, 'user@example.com', {
      access_token: 'fresh-access-token',
      refresh_token: 'fresh-refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
      token_type: 'Bearer',
      scope: 'offline_access Mail.Read',
    });

    const provider = new TokenProvider(configDir, 'client-id', 'user@example.com');
    await expect(provider.getAccessToken()).resolves.toBe('fresh-access-token');
  });

  it('lists accounts from accounts.json and resolves default account when email omitted', async () => {
    writeAccountsFile(configDir, [
      { email: 'first@example.com', displayName: 'First' },
      { email: 'second@example.com', displayName: 'Second' },
    ]);
    writeTokenFile(configDir, 'first@example.com', {
      access_token: 'first-token',
      expires_at: Date.now() + 60 * 60 * 1000,
      token_type: 'Bearer',
    });

    const provider = new TokenProvider(configDir, 'client-id');
    const accounts = await provider.loadAccounts();
    expect(accounts.map(a => a.email)).toEqual(['first@example.com', 'second@example.com']);
    await expect(provider.getAccessToken()).resolves.toBe('first-token');
  });

  it('falls back to legacy tokens.json when per-account file is missing', async () => {
    writeAccountsFile(configDir, [{ email: 'legacy@example.com' }]);
    fs.writeFileSync(
      path.join(configDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'legacy-token',
        expires_at: Date.now() + 60 * 60 * 1000,
        token_type: 'Bearer',
      }),
      { mode: 0o600 },
    );

    const provider = new TokenProvider(configDir, 'client-id', 'legacy@example.com');
    await expect(provider.getAccessToken()).resolves.toBe('legacy-token');
  });

  it('throws when no token is found at all', async () => {
    writeAccountsFile(configDir, [{ email: 'nope@example.com' }]);
    const provider = new TokenProvider(configDir, 'client-id', 'nope@example.com');
    await expect(provider.getAccessToken()).rejects.toThrow(/No Microsoft token found/);
  });

  it('throws when accounts.json has no entries', async () => {
    const provider = new TokenProvider(configDir, 'client-id');
    await expect(provider.getAccessToken()).rejects.toThrow(/No Microsoft account found/);
  });
});

describe('TokenProvider — MICROSOFT_DISABLE_REFRESH', () => {
  let configDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configDir = makeConfigDir('microsoft-shared-refresh-disabled-');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('throws MicrosoftRefreshDisabledError when token expired and host disabled refresh', async () => {
    writeAccountsFile(configDir, [{ email: 'user@example.com' }]);
    writeTokenFile(configDir, 'user@example.com', {
      access_token: 'expired-access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() - 60 * 1000,
      token_type: 'Bearer',
    });

    vi.stubEnv('MICROSOFT_DISABLE_REFRESH', '1');

    const provider = new TokenProvider(configDir, 'client-id', 'user@example.com');
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(MicrosoftRefreshDisabledError);
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      code: 'MICROSOFT_REFRESH_DISABLED',
      reason: 'token_expired',
      email: 'user@example.com',
    });

    const tokenEndpointCalls = fetchSpy.mock.calls.filter(call => String(call[0]).includes(TOKEN_ENDPOINT));
    expect(tokenEndpointCalls).toHaveLength(0);
  });

  it('still permits refresh when MICROSOFT_DISABLE_REFRESH is not set', async () => {
    writeAccountsFile(configDir, [{ email: 'user@example.com' }]);
    writeTokenFile(configDir, 'user@example.com', {
      access_token: 'expired-access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() - 60 * 1000,
      token_type: 'Bearer',
    });

    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'rotated-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    } as Response);

    const provider = new TokenProvider(configDir, 'client-id', 'user@example.com');
    await expect(provider.getAccessToken()).resolves.toBe('rotated-access-token');

    const tokenEndpointCalls = fetchSpy.mock.calls.filter(call => String(call[0]).includes(TOKEN_ENDPOINT));
    expect(tokenEndpointCalls).toHaveLength(1);
  });
});

describe('TokenProvider — atomic write + 0600 permissions', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = makeConfigDir('microsoft-shared-atomic-');
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rotates token atomically with 0600 permissions when refresh succeeds', async () => {
    writeAccountsFile(configDir, [{ email: 'user@example.com' }]);
    writeTokenFile(configDir, 'user@example.com', {
      access_token: 'expired-access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() - 60 * 1000,
      token_type: 'Bearer',
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'rotated-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    } as Response);

    const provider = new TokenProvider(configDir, 'client-id', 'user@example.com');
    await provider.getAccessToken();

    const tokenPath = path.join(configDir, 'credentials', 'user-example-com.token.json');
    const contents = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    expect(contents.access_token).toBe('rotated-access-token');

    if (process.platform !== 'win32') {
      const stat = fs.statSync(tokenPath);
      expect(stat.mode & 0o777).toBe(0o600);
    }

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('leaves no temp files behind after a successful refresh', async () => {
    writeAccountsFile(configDir, [{ email: 'user@example.com' }]);
    writeTokenFile(configDir, 'user@example.com', {
      access_token: 'expired-access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() - 60 * 1000,
      token_type: 'Bearer',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'rotated-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    } as Response);

    const provider = new TokenProvider(configDir, 'client-id', 'user@example.com');
    await provider.getAccessToken();

    const credentialsDir = path.join(configDir, 'credentials');
    const leftovers = await fsp.readdir(credentialsDir);
    expect(leftovers.filter(name => name.includes('.tmp.'))).toHaveLength(0);
  });
});

describe('email sanitiser parity', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = makeConfigDir('microsoft-shared-sanitiser-');
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it.each([
    ['harry@mindstone.ai', 'harry-mindstone-ai'],
    ['First.Last+tag@example.com', 'First-Last-tag-example-com'],
    ['UPPER@EXAMPLE.COM', 'UPPER-EXAMPLE-COM'],
    ['déjà.vu@example.fr', 'd-j--vu-example-fr'],
  ])('uses bundled-cohort sanitiser for %s', async (email, expectedSlug) => {
    writeAccountsFile(configDir, [{ email }]);
    writeTokenFile(configDir, email, {
      access_token: `token-for-${expectedSlug}`,
      expires_at: Date.now() + 60 * 60 * 1000,
      token_type: 'Bearer',
    });

    const provider = new TokenProvider(configDir, 'client-id', email);
    await expect(provider.getAccessToken()).resolves.toBe(`token-for-${expectedSlug}`);

    const tokenPath = path.join(configDir, 'credentials', `${expectedSlug}.token.json`);
    expect(fs.existsSync(tokenPath)).toBe(true);
  });
});
