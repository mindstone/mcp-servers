import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_FILE_REFUSED_RESOLUTION,
  CredentialFileRefusedError,
  readCredentialFile,
} from '../src/utils/guardedCredentialRead.js';

const EMAIL = 'user@example.com';
const TOKEN_FILE = 'user-example-com.token.json';
const TARGET_SECRET = 'target-secret-do-not-read';

const VALID_TOKEN = JSON.stringify({
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expiry_date: Date.now() + 3_600_000,
  scope: 'https://mail.google.com/',
});

let directory: string | undefined;

function makeDir(prefix: string): string {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return directory;
}

/** A link target with distinct content, outside the credentials directory. */
function plantTarget(root: string): string {
  const target = path.join(root, 'elsewhere.json');
  fs.writeFileSync(target, JSON.stringify({ access_token: TARGET_SECRET, expiry_date: Date.now() + 3_600_000 }));
  return target;
}

function expectRefusalHidesTarget(error: unknown, target: string) {
  const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).message}`;
  expect(text).not.toContain(TARGET_SECRET);
  expect(text).not.toContain(target);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('readCredentialFile', () => {
  it('reads a regular file', async () => {
    const root = makeDir('guarded-read-regular-');
    const file = path.join(root, 'token.json');
    fs.writeFileSync(file, VALID_TOKEN);
    await expect(readCredentialFile(file)).resolves.toBe(VALID_TOKEN);
  });

  it('returns null for a missing file', async () => {
    const root = makeDir('guarded-read-missing-');
    await expect(readCredentialFile(path.join(root, 'absent.json'))).resolves.toBeNull();
  });

  it('refuses a symlink to a valid file without reading the target', async () => {
    const root = makeDir('guarded-read-symlink-');
    const target = plantTarget(root);
    const link = path.join(root, 'token.json');
    fs.symlinkSync(target, link);
    const error = await readCredentialFile(link).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialFileRefusedError);
    expect((error as CredentialFileRefusedError).reason).toBe('link');
    expectRefusalHidesTarget(error, target);
  });

  it('refuses a dangling symlink rather than treating it as missing', async () => {
    const root = makeDir('guarded-read-dangling-');
    const link = path.join(root, 'token.json');
    fs.symlinkSync(path.join(root, 'does-not-exist.json'), link);
    await expect(readCredentialFile(link)).rejects.toMatchObject({ name: 'CredentialFileRefusedError', reason: 'link' });
  });

  it('refuses a directory', async () => {
    const root = makeDir('guarded-read-directory-');
    const dir = path.join(root, 'token.json');
    fs.mkdirSync(dir);
    await expect(readCredentialFile(dir)).rejects.toMatchObject({
      name: 'CredentialFileRefusedError',
      reason: 'not a plain file',
    });
  });

  it.skipIf(process.platform === 'win32')('refuses a link swapped in between the lstat and the open', async () => {
    const root = makeDir('guarded-read-swap-before-open-');
    const target = plantTarget(root);
    const file = path.join(root, 'token.json');
    fs.writeFileSync(file, VALID_TOKEN);
    const realOpen = fsp.open.bind(fsp);
    const open = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      // The lstat has already passed on the regular file; replace it with a link now.
      fs.rmSync(file);
      fs.symlinkSync(target, file);
      return realOpen(...args);
    });
    const error = await readCredentialFile(file).catch((e: unknown) => e);
    expect(open).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(CredentialFileRefusedError);
    expect((error as CredentialFileRefusedError).reason).toBe('link');
    expectRefusalHidesTarget(error, target);
  });

  it('reads the opened file even if the path is replaced after the open', async () => {
    const root = makeDir('guarded-read-swap-after-open-');
    const file = path.join(root, 'token.json');
    fs.writeFileSync(file, VALID_TOKEN);
    const replacement = path.join(root, 'replacement.json');
    fs.writeFileSync(replacement, JSON.stringify({ access_token: TARGET_SECRET }));
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      fs.renameSync(replacement, file);
      return handle;
    });
    await expect(readCredentialFile(file)).resolves.toBe(VALID_TOKEN);
    expect(fs.readFileSync(file, 'utf8')).toContain(TARGET_SECRET);
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without hanging', async () => {
    const root = makeDir('guarded-read-fifo-');
    const fifo = path.join(root, 'token.json');
    execFileSync('mkfifo', [fifo]);
    await expect(readCredentialFile(fifo)).rejects.toMatchObject({
      name: 'CredentialFileRefusedError',
      reason: 'not a plain file',
    });
  });
});

describe('TokenManager reads through the guarded reader', () => {
  async function tokenManagerWith(setup: (credentialsPath: string, root: string) => void) {
    const root = makeDir('guarded-read-token-');
    const credentialsPath = path.join(root, 'credentials');
    fs.mkdirSync(credentialsPath, { mode: 0o700 });
    setup(credentialsPath, root);
    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.resetModules();
    const { TokenManager } = await import('../src/modules/accounts/token.js');
    const logger = (await import('../src/utils/logger.js')).default;
    return { manager: new TokenManager(), logger, root };
  }

  function linkToken(credentialsPath: string, root: string) {
    fs.symlinkSync(plantTarget(root), path.join(credentialsPath, TOKEN_FILE));
  }

  it('loadToken reads a regular token file', async () => {
    const { manager } = await tokenManagerWith((credentialsPath) => {
      fs.writeFileSync(path.join(credentialsPath, TOKEN_FILE), VALID_TOKEN, { mode: 0o600 });
    });
    await expect(manager.loadToken(EMAIL)).resolves.toMatchObject({ access_token: 'access-token' });
  });

  it('loadToken returns null when no token file exists', async () => {
    const { manager } = await tokenManagerWith(() => {});
    await expect(manager.loadToken(EMAIL)).resolves.toBeNull();
  });

  it('loadToken turns a symlinked token into CREDENTIAL_FILE_REFUSED and logs no path or contents', async () => {
    let target = '';
    const { manager, logger } = await tokenManagerWith((credentialsPath, root) => {
      linkToken(credentialsPath, root);
      target = fs.readlinkSync(path.join(credentialsPath, TOKEN_FILE));
    });
    const warn = vi.spyOn(logger, 'warn');
    const error = await manager.loadToken(EMAIL).catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'AccountError',
      code: 'CREDENTIAL_FILE_REFUSED',
      resolution: CREDENTIAL_FILE_REFUSED_RESOLUTION,
    });
    expectRefusalHidesTarget(error, target);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(TARGET_SECRET);
    expect(logged).not.toContain(target);
    expect(logged).not.toContain(TOKEN_FILE);
  });

  it('autoRenewToken rethrows the refusal instead of returning an ERROR status', async () => {
    const { manager } = await tokenManagerWith(linkToken);
    await expect(manager.autoRenewToken(EMAIL)).rejects.toMatchObject({ code: 'CREDENTIAL_FILE_REFUSED' });
  });

  it('validateToken rethrows the refusal instead of returning an ERROR status', async () => {
    const { manager } = await tokenManagerWith(linkToken);
    await expect(manager.validateToken(EMAIL)).rejects.toMatchObject({ code: 'CREDENTIAL_FILE_REFUSED' });
  });
});

describe('AccountManager reads through the guarded reader', () => {
  async function accountManager(accountsPath: string, credentialsPath: string) {
    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
    vi.resetModules();
    const { AccountManager } = await import('../src/modules/accounts/manager.js');
    return new AccountManager({ accountsPath });
  }

  it('loadAccounts refuses a symlinked accounts file and writes nothing', async () => {
    const root = makeDir('guarded-read-accounts-link-');
    const credentialsPath = path.join(root, 'credentials');
    fs.mkdirSync(credentialsPath);
    const target = path.join(root, 'elsewhere-accounts.json');
    const original = JSON.stringify({ accounts: [{ email: 'attacker@example.com', category: 'x', description: 'y' }] });
    fs.writeFileSync(target, original);
    const accountsPath = path.join(root, 'accounts.json');
    fs.symlinkSync(target, accountsPath);

    const manager = await accountManager(accountsPath, credentialsPath);
    const error = await manager.initialize().catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'AccountError',
      code: 'CREDENTIAL_FILE_REFUSED',
      resolution: CREDENTIAL_FILE_REFUSED_RESOLUTION,
    });
    expect(JSON.stringify(error)).not.toContain('attacker@example.com');
    expect(fs.lstatSync(accountsPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
  });

  it('loadAccounts still creates an empty accounts file when none exists', async () => {
    const root = makeDir('guarded-read-accounts-missing-');
    const credentialsPath = path.join(root, 'credentials');
    fs.mkdirSync(credentialsPath);
    const accountsPath = path.join(root, 'accounts.json');

    const manager = await accountManager(accountsPath, credentialsPath);
    await manager.initialize();
    expect(JSON.parse(fs.readFileSync(accountsPath, 'utf8'))).toEqual({ accounts: [] });
    await expect(manager.listAccounts()).resolves.toEqual([]);
  });

  it('listAccounts marks only the refused account invalid and still lists the others', async () => {
    const root = makeDir('guarded-read-list-');
    const credentialsPath = path.join(root, 'credentials');
    fs.mkdirSync(credentialsPath);
    const accountsPath = path.join(root, 'accounts.json');
    fs.writeFileSync(accountsPath, JSON.stringify({
      accounts: [
        { email: EMAIL, category: 'work', description: 'Linked token' },
        { email: 'other@example.com', category: 'work', description: 'Plain token' },
      ],
    }));
    fs.symlinkSync(plantTarget(root), path.join(credentialsPath, TOKEN_FILE));
    fs.writeFileSync(path.join(credentialsPath, 'other-example-com.token.json'), VALID_TOKEN, { mode: 0o600 });

    const manager = await accountManager(accountsPath, credentialsPath);
    await manager.initialize();
    const accounts = await manager.listAccounts();
    expect(accounts.map(a => a.email)).toEqual([EMAIL, 'other@example.com']);
    expect(accounts[0].auth_status).toEqual({
      valid: false,
      status: 'ERROR',
      reason: CREDENTIAL_FILE_REFUSED_RESOLUTION,
    });
    expect(accounts[1].auth_status).toMatchObject({ valid: true, status: 'VALID' });
  });
});

describe('a real tool call with a symlinked token', () => {
  it('returns the refusal guidance, not a sign-in prompt', async () => {
    const root = makeDir('guarded-read-tool-');
    const credentialsPath = path.join(root, 'credentials');
    fs.mkdirSync(credentialsPath, { mode: 0o700 });
    const accountsPath = path.join(root, 'accounts.json');
    fs.writeFileSync(accountsPath, JSON.stringify({
      accounts: [{ email: EMAIL, category: 'work', description: 'Linked token' }],
    }));
    const target = plantTarget(root);
    fs.symlinkSync(target, path.join(credentialsPath, TOKEN_FILE));

    vi.stubEnv('ACCOUNTS_PATH', accountsPath);
    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('MCP_WORKSPACE_PATH', root);
    vi.resetModules();
    const { initializeAllServices } = await import('../src/utils/service-initializer.js');
    await initializeAllServices();
    const { GSuiteServer } = await import('../src/tools/server.js');
    const server = new GSuiteServer() as unknown as {
      server: { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<{
        isError?: boolean; content: Array<{ text: string }>;
      }>> };
    };
    const handler = server.server._requestHandlers.get('tools/call')!;
    const result = await handler({
      method: 'tools/call',
      params: { name: 'search_workspace_emails', arguments: { email: EMAIL, query: 'x' } },
    }, {});

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.action_required).toBe(`Google Workspace account problem. ${CREDENTIAL_FILE_REFUSED_RESOLUTION}`);
    expect(body.next_step).toBe(CREDENTIAL_FILE_REFUSED_RESOLUTION);
    expect(body.status).toBeUndefined();
    expect(text).not.toContain('auth_required');
    expect(text).not.toContain('authenticate_workspace_account');
    expect(text).not.toContain(TARGET_SECRET);
    expect(text).not.toContain(target);
  });
});

describe('get_current_time with a sign-in refused after the auth checks', () => {
  async function setUp() {
    const root = makeDir('guarded-read-current-time-');
    const credentialsPath = path.join(root, 'credentials');
    fs.mkdirSync(credentialsPath, { mode: 0o700 });
    const accountsPath = path.join(root, 'accounts.json');
    fs.writeFileSync(accountsPath, JSON.stringify({
      accounts: [{ email: EMAIL, category: 'work', description: 'Plain token' }],
    }));
    const tokenPath = path.join(credentialsPath, TOKEN_FILE);
    fs.writeFileSync(tokenPath, VALID_TOKEN, { mode: 0o600 });

    vi.stubEnv('ACCOUNTS_PATH', accountsPath);
    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('MCP_WORKSPACE_PATH', root);
    vi.resetModules();
    const { initializeAllServices } = await import('../src/utils/service-initializer.js');
    await initializeAllServices();
    const { getAccountManager } = await import('../src/modules/accounts/index.js');
    const manager = getAccountManager();
    const { GSuiteServer } = await import('../src/tools/server.js');
    const server = new GSuiteServer() as unknown as {
      server: { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<{
        isError?: boolean; content: Array<{ text: string }>;
      }>> };
    };
    const call = () => server.server._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: { name: 'get_current_time', arguments: { email: EMAIL } },
    }, {});
    return { root, tokenPath, manager, call };
  }

  it('returns the refusal guidance instead of a UTC answer', async () => {
    const { root, tokenPath, manager, call } = await setUp();
    const target = plantTarget(root);
    const realValidate = manager.validateToken.bind(manager);
    let calls = 0;
    // The handler's own auth gate is the first validateToken; the timezone helper's is the
    // second. Swap the token for a link just before the helper's read.
    vi.spyOn(manager, 'validateToken').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) {
        fs.rmSync(tokenPath);
        fs.symlinkSync(target, tokenPath);
      }
      return realValidate(...args);
    });

    const result = await call();
    expect(calls).toBe(2);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.next_step).toBe(CREDENTIAL_FILE_REFUSED_RESOLUTION);
    expect(text).not.toContain('"timezone"');
    expect(text).not.toContain(TARGET_SECRET);
    expect(text).not.toContain(target);
  });

  it('still falls back to UTC when the timezone lookup fails for an ordinary reason', async () => {
    const { manager, call } = await setUp();
    const realValidate = manager.validateToken.bind(manager);
    let calls = 0;
    vi.spyOn(manager, 'validateToken').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) return { valid: false, status: 'INVALID', reason: 'Invalid token format' };
      return realValidate(...args);
    });

    const result = await call();
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('UTC');
  });
});

describe('list_drive_files with a sign-in refused on the Drive scope check', () => {
  it('returns the refusal resolution, not a generic Drive failure or a sign-in prompt', async () => {
    const root = makeDir('guarded-read-drive-');
    const credentialsPath = path.join(root, 'credentials');
    fs.mkdirSync(credentialsPath, { mode: 0o700 });
    const accountsPath = path.join(root, 'accounts.json');
    fs.writeFileSync(accountsPath, JSON.stringify({
      accounts: [{ email: EMAIL, category: 'work', description: 'Plain token' }],
    }));
    const tokenPath = path.join(credentialsPath, TOKEN_FILE);
    fs.writeFileSync(tokenPath, VALID_TOKEN, { mode: 0o600 });
    const target = plantTarget(root);

    vi.stubEnv('ACCOUNTS_PATH', accountsPath);
    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('MCP_WORKSPACE_PATH', root);
    vi.resetModules();
    const { initializeAllServices } = await import('../src/utils/service-initializer.js');
    await initializeAllServices();
    const { getAccountManager } = await import('../src/modules/accounts/index.js');
    const manager = getAccountManager();
    const { DriveService } = await import('../src/modules/drive/service.js');
    const { GSuiteServer } = await import('../src/tools/server.js');
    const server = new GSuiteServer() as unknown as {
      server: { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<{
        isError?: boolean; content: Array<{ text: string }>;
      }>> };
    };

    // The first read (withTokenRenewal's renewal check) sees the plain file; swap it for
    // a link just before DriveService's own scope check reads it again.
    const renew = vi.spyOn(
      (manager as unknown as { tokenManager: { autoRenewToken: (email: string) => Promise<unknown> } }).tokenManager,
      'autoRenewToken',
    );
    const proto = DriveService.prototype as unknown as {
      validateScopes: (...args: unknown[]) => Promise<void>;
    };
    const realValidateScopes = proto.validateScopes;
    let scopeChecks = 0;
    vi.spyOn(proto, 'validateScopes').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      scopeChecks += 1;
      fs.rmSync(tokenPath);
      fs.symlinkSync(target, tokenPath);
      return realValidateScopes.apply(this, args);
    });

    const result = await server.server._requestHandlers.get('tools/call')!({
      method: 'tools/call',
      params: { name: 'list_drive_files', arguments: { email: EMAIL } },
    }, {});

    expect(renew).toHaveBeenCalled();
    await expect(renew.mock.results[0].value).resolves.toMatchObject({ success: true });
    expect(scopeChecks).toBe(1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.action_required).toBe(`Google Workspace account problem. ${CREDENTIAL_FILE_REFUSED_RESOLUTION}`);
    expect(body.next_step).toBe(CREDENTIAL_FILE_REFUSED_RESOLUTION);
    expect(body.status).toBeUndefined();
    expect(text).not.toContain('auth_required');
    expect(text).not.toContain('authenticate_workspace_account');
    expect(text).not.toContain('Drive list files failed');
    expect(text).not.toContain('Check Google Workspace authentication and Drive permissions');
    expect(text).not.toContain(TARGET_SECRET);
    expect(text).not.toContain(target);
  });
});
