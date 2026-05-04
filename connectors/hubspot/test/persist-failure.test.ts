import fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetRefreshStateForTests, refreshTokenForAccount } from '../src/modules/accounts/oauth.js';
import {
  __resetAccountManagerForTests,
  type TokenData,
  TokenPersistFailedError,
} from '../src/modules/accounts/manager.js';

const TEST_EMAIL = 'persist-failure@example.com';

function createConfigDir(prefix: string): string {
  const configDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  return configDir;
}

function createExpiringToken(): TokenData {
  return {
    access_token: 'old-access-token',
    refresh_token: 'old-refresh-token',
    expires_at: Date.now() - 5_000,
    hub_id: 321,
    user: TEST_EMAIL,
    schemaVersion: 1,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetRefreshStateForTests();
  __resetAccountManagerForTests();
  delete process.env.HUBSPOT_CONFIG_DIR;
  delete process.env.HUBSPOT_CLIENT_ID;
  delete process.env.HUBSPOT_CLIENT_SECRET;
});

describe('refresh persist-failure handling', () => {
  it('surfaces TOKEN_PERSIST_FAILED and preserves the rotated in-memory token payload', async () => {
    const configDir = createConfigDir('hubspot-persist-failure-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_CLIENT_ID = 'client-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'client-secret';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'fresh-access-token',
      refresh_token: 'fresh-refresh-token',
      expires_in: 3600,
      token_type: 'bearer',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const persistFailure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw persistFailure;
    });

    const originalToken = createExpiringToken();

    try {
      await refreshTokenForAccount(TEST_EMAIL, originalToken, {
        lockOptions: { retries: { retries: 0, minTimeout: 1, maxTimeout: 1 } },
      });
      throw new Error('Expected refreshTokenForAccount to throw TokenPersistFailedError');
    } catch (error) {
      expect(error).toBeInstanceOf(TokenPersistFailedError);
      const persistError = error as TokenPersistFailedError;
      expect(persistError.code).toBe('TOKEN_PERSIST_FAILED');
      expect(persistError.tokenData.access_token).toBe('fresh-access-token');
      expect(originalToken.access_token).toBe('old-access-token');
    }

    rmSync(configDir, { recursive: true, force: true });
  });

  it('keeps TokenPersistFailedError tokenData non-enumerable for JSON serialization', () => {
    const tokenData: TokenData = {
      access_token: 'rotated-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_at: Date.now() + 60_000,
      schemaVersion: 1,
    };

    const error = new TokenPersistFailedError(
      TEST_EMAIL,
      '/tmp/fake.token.json',
      tokenData,
      new Error('disk full'),
    );

    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
    expect(serialized).not.toContain('tokenData');
  });
});
