import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './fixtures/setup.js';

describe('GOOGLE_WORKSPACE_DISABLE_REFRESH=1', () => {
  let cleanupDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (cleanupDir) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  it('returns auth_required renewal status without calling oauth2 token endpoint', async () => {
    let tokenCalls = 0;
    mswServer.use(
      http.post('https://oauth2.googleapis.com/token', () => {
        tokenCalls += 1;
        return HttpResponse.json({ access_token: 'rotated', expires_in: 3600 });
      }),
    );

    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-disable-refresh-'));
    const credentialsPath = path.join(cleanupDir, 'credentials');
    fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(credentialsPath, 'user-example-com.token.json'),
      JSON.stringify({
        access_token: 'expired-access-token',
        refresh_token: 'refresh-token',
        expiry_date: Date.now() - 60_000,
      }),
      { mode: 0o600 },
    );

    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.stubEnv('GOOGLE_WORKSPACE_DISABLE_REFRESH', '1');
    vi.resetModules();
    const { TokenManager } = await import('../src/modules/accounts/token.js');
    const tokenManager = new TokenManager();

    const renewal = await tokenManager.autoRenewToken('user@example.com');
    const validation = await tokenManager.validateToken('user@example.com');

    expect(renewal).toMatchObject({
      success: false,
      status: 'AUTH_REQUIRED',
    });
    expect(validation).toMatchObject({
      valid: false,
      status: 'AUTH_REQUIRED',
    });
    expect(tokenCalls).toBe(0);
  });

  it('maps operation 401 to AUTH_REQUIRED without refreshing when refresh is disabled', async () => {
    let tokenCalls = 0;
    mswServer.use(
      http.post('https://oauth2.googleapis.com/token', () => {
        tokenCalls += 1;
        return HttpResponse.json({ access_token: 'rotated', expires_in: 3600 });
      }),
    );

    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-disable-refresh-401-'));
    const accountsPath = path.join(cleanupDir, 'accounts.json');
    const credentialsPath = path.join(cleanupDir, 'credentials');
    fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(accountsPath, JSON.stringify({
      accounts: [{ email: 'user@example.com', category: 'work', description: 'User' }],
    }));
    fs.writeFileSync(
      path.join(credentialsPath, 'user-example-com.token.json'),
      JSON.stringify({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry_date: Date.now() + 60_000,
      }),
      { mode: 0o600 },
    );

    vi.stubEnv('ACCOUNTS_PATH', accountsPath);
    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('GOOGLE_WORKSPACE_DISABLE_REFRESH', '1');
    vi.resetModules();

    const { AccountManager } = await import('../src/modules/accounts/manager.js');
    const { AccountError } = await import('../src/modules/accounts/types.js');
    const { GSuiteServer } = await import('../src/tools/server.js');
    const manager = new AccountManager();
    await manager.initialize();

    await expect(manager.withTokenRenewal('user@example.com', async () => {
      throw { response: { status: 401 }, code: '401' };
    })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(tokenCalls).toBe(0);

    const response = (new GSuiteServer() as unknown as {
      formatErrorResponse(error: unknown): unknown;
    }).formatErrorResponse(new AccountError('Authentication required', 'AUTH_REQUIRED', 'Connect Google Workspace to continue'));
    expect(response).toMatchObject({
      status: 'auth_required',
      user_action: { id: 'google.connect_account' },
      setupToolName: 'authenticate_workspace_account',
    });
  });

  it('maps invalid_grant refresh failures to AUTH_REQUIRED', async () => {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-invalid-grant-'));
    const credentialsPath = path.join(cleanupDir, 'credentials');
    fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(credentialsPath, 'user-example-com.token.json'),
      JSON.stringify({
        access_token: 'expired-access-token',
        refresh_token: 'refresh-token',
        expiry_date: Date.now() - 60_000,
      }),
      { mode: 0o600 },
    );

    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.resetModules();
    const { TokenManager } = await import('../src/modules/accounts/token.js');
    const tokenManager = new TokenManager({
      refreshToken: async () => {
        throw new Error('invalid_grant');
      },
    } as never);

    await expect(tokenManager.autoRenewToken('user@example.com')).resolves.toMatchObject({
      success: false,
      status: 'AUTH_REQUIRED',
    });
    await expect(tokenManager.validateToken('user@example.com')).resolves.toMatchObject({
      valid: false,
      status: 'AUTH_REQUIRED',
    });
  });
});
