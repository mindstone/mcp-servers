import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MicrosoftCredentialFileError,
  MicrosoftRefreshDisabledError,
  TokenProvider,
  type MicrosoftCredentialFileReason,
} from '../src/tokenProvider.js';

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

  it('fails closed when per-account token file is malformed (no legacy fallback)', async () => {
    writeAccountsFile(configDir, [{ email: 'legacy@example.com' }]);
    const tokenPath = path.join(configDir, 'credentials', 'legacy-example-com.token.json');
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, '{ not-json', { mode: 0o600 });

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
    await expect(provider.getAccessToken()).rejects.toThrow();
  });

  it('throws when legacy tokens.json is malformed and per-account file is missing', async () => {
    writeAccountsFile(configDir, [{ email: 'legacy@example.com' }]);
    fs.writeFileSync(path.join(configDir, 'tokens.json'), '{ broken-json', { mode: 0o600 });

    const provider = new TokenProvider(configDir, 'client-id', 'legacy@example.com');
    await expect(provider.getAccessToken()).rejects.toThrow();
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
    ['jane@example.com', 'jane-example-com'],
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

describe('TokenProvider — guarded, schema-parsed credential reads', () => {
  const posixOnly = process.platform === 'win32' ? it.skip : it;
  const email = 'user@example.com';
  const slug = 'user-example-com';
  // Distinctive bytes so a test can prove none of the file content reaches an error.
  const SECRET_MARKER = 'SECRET-BYTES-do-not-echo-7f3a';
  let configDir: string;

  function tokenPath(): string {
    return path.join(configDir, 'credentials', `${slug}.token.json`);
  }

  function writeRawToken(contents: string): string {
    const p = tokenPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, contents, { mode: 0o600 });
    return p;
  }

  function writeRawAccounts(contents: string): string {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const p = path.join(configDir, 'accounts.json');
    fs.writeFileSync(p, contents, { mode: 0o600 });
    return p;
  }

  async function expectRefusal(promise: Promise<unknown>, reason: MicrosoftCredentialFileReason): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MicrosoftCredentialFileError);
    const err = caught as MicrosoftCredentialFileError;
    expect(err.reason).toBe(reason);
    expect(err.code).toBe('MICROSOFT_CREDENTIAL_FILE_INVALID');
    expect(err.message).not.toContain(configDir);
    expect(err.message).not.toContain(slug);
    expect(err.message).not.toContain(SECRET_MARKER);
    expect(err.message).not.toContain('{');
    expect(String(err.stack ?? '')).not.toContain(SECRET_MARKER);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  }

  beforeEach(() => {
    configDir = makeConfigDir('microsoft-shared-guarded-');
    writeAccountsFile(configDir, [{ email }]);
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  posixOnly('refuses a symlinked token file', async () => {
    const realFile = path.join(configDir, 'elsewhere.json');
    fs.writeFileSync(realFile, JSON.stringify({ access_token: SECRET_MARKER, expires_at: Date.now() + 3_600_000 }));
    fs.mkdirSync(path.dirname(tokenPath()), { recursive: true, mode: 0o700 });
    fs.symlinkSync(realFile, tokenPath());

    const provider = new TokenProvider(configDir, 'client-id', email);
    await expectRefusal(provider.loadToken(), 'symlink');
    await expect(provider.hasValidToken()).resolves.toBe(false);
  });

  posixOnly('refuses a symlinked accounts file', async () => {
    const realFile = path.join(configDir, 'other-accounts.json');
    fs.writeFileSync(realFile, JSON.stringify({ accounts: [{ email }] }));
    fs.rmSync(path.join(configDir, 'accounts.json'));
    fs.symlinkSync(realFile, path.join(configDir, 'accounts.json'));

    const provider = new TokenProvider(configDir, 'client-id');
    await expectRefusal(provider.loadAccounts(), 'symlink');
    await expect(provider.hasValidToken()).resolves.toBe(false);
  });

  it('refuses a directory at the token path', async () => {
    fs.mkdirSync(tokenPath(), { recursive: true });

    const provider = new TokenProvider(configDir, 'client-id', email);
    await expectRefusal(provider.loadToken(), 'not_regular_file');
    await expect(provider.hasValidToken()).resolves.toBe(false);
  });

  it('refuses a directory at the accounts path', async () => {
    fs.rmSync(path.join(configDir, 'accounts.json'));
    fs.mkdirSync(path.join(configDir, 'accounts.json'));

    const provider = new TokenProvider(configDir, 'client-id');
    await expectRefusal(provider.loadAccounts(), 'not_regular_file');
  });

  posixOnly('refuses a FIFO at the token path without hanging', async () => {
    fs.mkdirSync(path.dirname(tokenPath()), { recursive: true, mode: 0o700 });
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [tokenPath()]);

    const provider = new TokenProvider(configDir, 'client-id', email);
    await expectRefusal(provider.loadToken(), 'not_regular_file');
    await expect(provider.hasValidToken()).resolves.toBe(false);
  }, 5_000);

  it('refuses a token file over the size cap', async () => {
    writeRawToken(JSON.stringify({
      access_token: SECRET_MARKER + 'a'.repeat(70 * 1024),
      expires_at: Date.now() + 3_600_000,
    }));

    const provider = new TokenProvider(configDir, 'client-id', email);
    await expectRefusal(provider.loadToken(), 'too_large');
    await expect(provider.hasValidToken()).resolves.toBe(false);
  });

  it('refuses an accounts file over the size cap', async () => {
    writeRawAccounts(JSON.stringify({ accounts: [{ email, displayName: 'x'.repeat(70 * 1024) }] }));

    const provider = new TokenProvider(configDir, 'client-id');
    await expectRefusal(provider.loadAccounts(), 'too_large');
  });

  it('refuses malformed token JSON with a fixed message naming no path or content', async () => {
    writeRawToken(`{ "access_token": "${SECRET_MARKER}", broken`);

    const provider = new TokenProvider(configDir, 'client-id', email);
    await expectRefusal(provider.loadToken(), 'malformed_json');
    await expectRefusal(provider.getAccessToken(), 'malformed_json');
    await expect(provider.hasValidToken()).resolves.toBe(false);
  });

  it('refuses malformed accounts JSON with a fixed message', async () => {
    writeRawAccounts(`{ "accounts": [ "${SECRET_MARKER}" `);

    const provider = new TokenProvider(configDir, 'client-id');
    await expectRefusal(provider.loadAccounts(), 'malformed_json');
    await expect(provider.hasValidToken()).resolves.toBe(false);
  });

  it('refuses malformed legacy tokens.json with a fixed message', async () => {
    fs.writeFileSync(path.join(configDir, 'tokens.json'), `{ ${SECRET_MARKER}`, { mode: 0o600 });

    const provider = new TokenProvider(configDir, 'client-id', email);
    await expectRefusal(provider.loadToken(), 'malformed_json');
  });

  it.each([
    ['access_token is a number', { access_token: 12345, expires_at: Date.now() + 3_600_000 }],
    ['refresh_token is an object', { access_token: 'ok', refresh_token: { value: SECRET_MARKER }, expires_at: 1 }],
    ['scope is an array', { access_token: 'ok', scope: ['Mail.Read'], expires_at: 1 }],
    ['expires_at is a boolean', { access_token: 'ok', expires_at: true }],
    ['top level is an array', [SECRET_MARKER]],
  ])('refuses a token file whose %s', async (_label, body) => {
    writeRawToken(JSON.stringify(body));

    const provider = new TokenProvider(configDir, 'client-id', email);
    await expectRefusal(provider.loadToken(), 'invalid_shape');
    await expect(provider.hasValidToken()).resolves.toBe(false);
  });

  it.each([
    ['accounts is an object', { accounts: { email } }],
    ['an account email is empty', { accounts: [{ email: '' }] }],
    ['an account email is a number', { accounts: [{ email: 42 }] }],
    ['displayName is a number', { accounts: [{ email, displayName: 7 }] }],
  ])('refuses an accounts file where %s', async (_label, body) => {
    writeRawAccounts(JSON.stringify(body));

    const provider = new TokenProvider(configDir, 'client-id');
    await expectRefusal(provider.loadAccounts(), 'invalid_shape');
  });

  it('keeps missing-file results: [] accounts, then null token', async () => {
    fs.rmSync(path.join(configDir, 'accounts.json'));
    const provider = new TokenProvider(configDir, 'client-id', email);
    await expect(provider.loadAccounts()).resolves.toEqual([]);
    await expect(provider.loadToken()).resolves.toBeNull();
    await expect(provider.hasValidToken()).resolves.toBe(false);
  });

  it('keeps [] when accounts.json has no accounts key', async () => {
    writeRawAccounts(JSON.stringify({}));
    const provider = new TokenProvider(configDir, 'client-id');
    await expect(provider.loadAccounts()).resolves.toEqual([]);
  });

  it('still returns null for an empty access_token (not a refusal)', async () => {
    writeRawToken(JSON.stringify({ access_token: '', expires_at: 1 }));
    const provider = new TokenProvider(configDir, 'client-id', email);
    await expect(provider.loadToken()).resolves.toBeNull();
  });

  // Exact shape written by the host's saveToken: JSON.stringify(tokenData, null, 2).
  it('parses the host-written token shape (pretty-printed, scope omitted when absent)', async () => {
    const expiresAt = Date.now() + 3_600_000;
    writeRawToken(JSON.stringify({
      access_token: 'host-access',
      refresh_token: 'host-refresh',
      expires_at: expiresAt,
      token_type: 'Bearer',
      scope: undefined,
    }, null, 2));

    const provider = new TokenProvider(configDir, 'client-id', email);
    await expect(provider.loadToken()).resolves.toEqual({
      access_token: 'host-access',
      refresh_token: 'host-refresh',
      expires_at: expiresAt,
      token_type: 'Bearer',
      scope: undefined,
    });
  });

  // The host's refresh writes `expires_at: Date.now() + expires_in * 1000`, which is NaN
  // (serialised as null) when Graph omits expires_in, and spreads the old token (extra keys).
  it('parses a host-refreshed token with expires_at: null and extra keys', async () => {
    writeRawToken(JSON.stringify({
      access_token: 'refreshed-access',
      refresh_token: 'refreshed-refresh',
      expires_at: Number.NaN,
      token_type: 'Bearer',
      scope: 'offline_access Mail.Read',
      id_token: 'extra',
      ext_expires_in: 3600,
    }, null, 2));

    const provider = new TokenProvider(configDir, 'client-id', email);
    const token = await provider.loadToken();
    expect(token?.access_token).toBe('refreshed-access');
    expect(token?.expires_at).toBe(0);
    expect(token?.scope).toBe('offline_access Mail.Read');
    await expect(provider.hasValidToken()).resolves.toBe(true);
  });

  it.each([
    ['expiresAt as an ISO string', { expiresAt: '2099-01-01T00:00:00.000Z' }, Date.parse('2099-01-01T00:00:00.000Z')],
    ['expires_at as a numeric string', { expires_at: '4102444800000' }, 4102444800000],
    ['expiresAt as a number', { expiresAt: 4102444800000 }, 4102444800000],
  ])('accepts %s', async (_label, expiry, expected) => {
    writeRawToken(JSON.stringify({ access_token: 'a', ...expiry }));
    const provider = new TokenProvider(configDir, 'client-id', email);
    const token = await provider.loadToken();
    expect(token?.expires_at).toBe(expected);
  });

  it('accepts expires_in (number and string) and nulls for optional fields', async () => {
    const before = Date.now();
    writeRawToken(JSON.stringify({
      access_token: 'a',
      expires_in: '3600',
      refresh_token: null,
      token_type: null,
      scope: null,
    }));
    const provider = new TokenProvider(configDir, 'client-id', email);
    const token = await provider.loadToken();
    expect(token?.expires_at).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(token?.token_type).toBe('Bearer');
  });

  it('parses the host-written accounts shape with extra keys', async () => {
    writeRawAccounts(JSON.stringify({
      accounts: [
        { email: 'first@example.com', displayName: 'First' },
        { email: 'second@example.com', displayName: '', tenantId: 'tenant-1' },
      ],
      extra: true,
    }, null, 2));

    const provider = new TokenProvider(configDir, 'client-id');
    const accounts = await provider.loadAccounts();
    expect(accounts.map(a => a.email)).toEqual(['first@example.com', 'second@example.com']);
    expect(accounts[1].tenantId).toBe('tenant-1');
  });

  it('reads a refused legacy file as a refusal, and a missing legacy file as null', async () => {
    fs.mkdirSync(path.join(configDir, 'tokens.json'));
    const provider = new TokenProvider(configDir, 'client-id', email);
    await expectRefusal(provider.loadToken(), 'not_regular_file');

    fs.rmSync(path.join(configDir, 'tokens.json'), { recursive: true });
    await expect(provider.loadToken()).resolves.toBeNull();
  });
});
