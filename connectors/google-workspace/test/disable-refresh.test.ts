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
});
