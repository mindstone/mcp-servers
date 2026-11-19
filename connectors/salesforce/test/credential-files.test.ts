/**
 * Saved sign-in files: guarded reads, exclusive tmp-file writes, and bridge
 * mode detection through the vendored reader's isBridgeConfigured.
 *
 * Reads must refuse a symlink, a FIFO or directory, an oversize file, malformed
 * JSON and a token whose instance_url / login_url is not https, failing closed
 * with one fixed stderr line that never carries the file content.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

import * as crypto from 'node:crypto';
import { MAX_CREDENTIAL_FILE_BYTES } from '../src/secure-read.js';

const SECRET = 'SECRET-ACCESS-TOKEN-VALUE';
const ACCOUNT = 'jane-example-com';

let base: string;
let credDir: string;
let errors: ReturnType<typeof vi.spyOn>;

function validToken(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: SECRET,
    refresh_token: 'SECRET-REFRESH',
    instance_url: 'https://acme.my.salesforce.com',
    login_url: 'https://login.salesforce.com',
    expires_at: Date.now() + 3_600_000,
    username: 'jane@example.com',
    ...extra,
  };
}

const tokenPath = () => path.join(credDir, `${ACCOUNT}.token.json`);
const accountsPath = () => path.join(base, 'accounts.json');

async function auth() {
  vi.resetModules();
  return import('../src/auth.js');
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'salesforce-cred-'));
  credDir = path.join(base, 'credentials');
  fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
  vi.stubEnv('SALESFORCE_CONFIG_DIR', base);
  vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
  vi.stubEnv('MINDSTONE_REBEL_BRIDGE_STATE', '');
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const call of errors.mock.calls) {
    expect(String(call)).not.toContain(SECRET);
    expect(String(call)).not.toContain(base);
  }
  errors.mockRestore();
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('loadToken', () => {
  it('reads a valid token and keeps unknown fields', async () => {
    fs.writeFileSync(tokenPath(), JSON.stringify(validToken({ future_field: 'kept' })), { mode: 0o600 });
    const { loadToken } = await auth();
    expect(loadToken(ACCOUNT)).toMatchObject({ access_token: SECRET, future_field: 'kept' });
    expect(errors).not.toHaveBeenCalled();
  });

  it('accepts a legacy token without login_url or refresh_token', async () => {
    fs.writeFileSync(
      tokenPath(),
      JSON.stringify({ access_token: SECRET, instance_url: 'https://acme.my.salesforce.com', issued_at: '1700000000000' }),
    );
    const { loadToken } = await auth();
    expect(loadToken(ACCOUNT)).toMatchObject({ access_token: SECRET });
  });

  it('returns null quietly when the token file is missing', async () => {
    const { loadToken } = await auth();
    expect(loadToken(ACCOUNT)).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ['an http instance_url', validToken({ instance_url: 'http://acme.my.salesforce.com' })],
    ['an http login_url', validToken({ login_url: 'http://login.example.com' })],
    ['a non-URL instance_url', validToken({ instance_url: 'not a url' })],
    ['a missing instance_url', validToken({ instance_url: undefined })],
    ['an empty access_token', validToken({ access_token: '' })],
    ['a string expires_at', validToken({ expires_at: 'soon' })],
    ['an array', [SECRET]],
  ])('refuses a token with %s', async (_label, content) => {
    fs.writeFileSync(tokenPath(), JSON.stringify(content));
    const { loadToken } = await auth();
    expect(loadToken(ACCOUNT)).toBeNull();
    expect(errors).toHaveBeenCalledWith('[salesforce] token file rejected: schema');
  });

  it('refuses malformed JSON', async () => {
    fs.writeFileSync(tokenPath(), `{"access_token": "${SECRET}"`);
    const { loadToken } = await auth();
    expect(loadToken(ACCOUNT)).toBeNull();
    expect(errors).toHaveBeenCalledWith('[salesforce] token file rejected: malformed');
  });

  it('refuses a file over the size cap', async () => {
    fs.writeFileSync(tokenPath(), JSON.stringify(validToken({ pad: 'x'.repeat(MAX_CREDENTIAL_FILE_BYTES) })));
    const { loadToken } = await auth();
    expect(loadToken(ACCOUNT)).toBeNull();
    expect(errors).toHaveBeenCalledWith('[salesforce] token file rejected: too large');
  });

  it('refuses a directory', async () => {
    fs.mkdirSync(tokenPath());
    const { loadToken } = await auth();
    expect(loadToken(ACCOUNT)).toBeNull();
    expect(errors).toHaveBeenCalledWith('[salesforce] token file rejected: not a regular file');
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink, even to a valid token', async () => {
    const target = path.join(base, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify(validToken()));
    fs.symlinkSync(target, tokenPath());
    const { loadToken } = await auth();
    expect(loadToken(ACCOUNT)).toBeNull();
    expect(errors).toHaveBeenCalledWith('[salesforce] token file rejected: symlink');
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without blocking on it', async () => {
    execFileSync('mkfifo', [tokenPath()]);
    const { loadToken } = await auth();
    expect(loadToken(ACCOUNT)).toBeNull();
    expect(errors).toHaveBeenCalledWith('[salesforce] token file rejected: not a regular file');
  });
});

describe('loadAccounts', () => {
  it('keeps legacy and sparse account shapes, unknown fields included', async () => {
    const accounts = [
      { id: 'a', username: 'jane@example.com', instance_url: 'https://acme.my.salesforce.com', is_sandbox: false },
      { username: 'john@example.com', instanceUrl: 'https://acme.my.salesforce.com', organizationId: '00D' },
      { id: 'c', extra: { nested: true } },
    ];
    fs.writeFileSync(accountsPath(), JSON.stringify({ accounts, version: 2 }));
    const { loadAccounts } = await auth();
    expect(loadAccounts()).toEqual({ accounts, version: 2 });
    expect(errors).not.toHaveBeenCalled();
  });

  it('returns an empty list quietly when the file is missing', async () => {
    const { loadAccounts } = await auth();
    expect(loadAccounts()).toEqual({ accounts: [] });
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ['no accounts array', { accounts: 'jane' }],
    ['a non-object entry', { accounts: ['jane'] }],
    ['a non-string id', { accounts: [{ id: 7 }] }],
    ['a non-boolean is_sandbox', { accounts: [{ id: 'a', is_sandbox: 'yes' }] }],
  ])('refuses a file with %s', async (_label, content) => {
    fs.writeFileSync(accountsPath(), JSON.stringify(content));
    const { loadAccounts } = await auth();
    expect(loadAccounts()).toEqual({ accounts: [] });
    expect(errors).toHaveBeenCalledWith('[salesforce] accounts file rejected: schema');
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked accounts file', async () => {
    const target = path.join(base, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ accounts: [{ id: 'a' }] }));
    fs.symlinkSync(target, accountsPath());
    const { loadAccounts } = await auth();
    expect(loadAccounts()).toEqual({ accounts: [] });
    expect(errors).toHaveBeenCalledWith('[salesforce] accounts file rejected: symlink');
  });
});

describe('credential writes', () => {
  const FIXED = 'aaaaaaaaaaaa';

  it('lands the token at 0600 by rename and leaves no tmp file', async () => {
    const { saveToken, loadToken } = await auth();
    saveToken(ACCOUNT, validToken() as never);
    if (process.platform !== 'win32') expect(fs.statSync(tokenPath()).mode & 0o777).toBe(0o600);
    expect(loadToken(ACCOUNT)).toMatchObject({ access_token: SECRET });
    expect(fs.readdirSync(credDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('never follows a symlink planted at the tmp path', async () => {
    const victim = path.join(base, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    fs.symlinkSync(victim, `${tokenPath()}.${FIXED}.tmp`);
    vi.mocked(crypto.randomBytes).mockReturnValueOnce(Buffer.from(FIXED, 'hex') as never);
    const { saveToken } = await auth();
    expect(() => saveToken(ACCOUNT, validToken() as never)).toThrow();
    expect(fs.readFileSync(victim, 'utf8')).toBe('original');
    expect(fs.lstatSync(`${tokenPath()}.${FIXED}.tmp`).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(tokenPath())).toBe(false);
  });

  it('refuses to reuse a regular file planted at the tmp path', async () => {
    const planted = `${tokenPath()}.${FIXED}.tmp`;
    fs.writeFileSync(planted, 'planted');
    vi.mocked(crypto.randomBytes).mockReturnValueOnce(Buffer.from(FIXED, 'hex') as never);
    const { saveToken } = await auth();
    expect(() => saveToken(ACCOUNT, validToken() as never)).toThrow();
    expect(fs.readFileSync(planted, 'utf8')).toBe('planted');
    expect(fs.existsSync(tokenPath())).toBe(false);
  });

  it('removes the tmp file when the rename fails', async () => {
    // A non-empty directory at the target makes the rename fail.
    fs.mkdirSync(tokenPath());
    fs.writeFileSync(path.join(tokenPath(), 'keep'), 'x');
    const { saveToken } = await auth();
    expect(() => saveToken(ACCOUNT, validToken() as never)).toThrow();
    expect(fs.readdirSync(credDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('bridge mode detection', () => {
  it.each([
    [{ MCP_HOST_BRIDGE_STATE: '/state.json', MINDSTONE_REBEL_BRIDGE_STATE: '' }, 'bridge'],
    [{ MCP_HOST_BRIDGE_STATE: '', MINDSTONE_REBEL_BRIDGE_STATE: '/state.json' }, 'bridge'],
    [{ MCP_HOST_BRIDGE_STATE: '', MINDSTONE_REBEL_BRIDGE_STATE: '' }, 'unconfigured'],
  ])('resolves %j to %s', async (env, mode) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.stubEnv('SALESFORCE_CLIENT_ID', '');
    vi.stubEnv('SALESFORCE_CLIENT_SECRET', '');
    vi.stubEnv('SALESFORCE_ACCESS_TOKEN', '');
    const { resolveAuthMode } = await auth();
    expect(resolveAuthMode()).toBe(mode);
  });
});
