/**
 * getHubSpotClientAsync client reuse: a same-account token file replacement
 * (reconnect / rotation that doesn't go through the expiry-refresh branch)
 * must build a NEW client — reusing the old one would keep calling the API
 * with the stale token and key per-token memoisation (tokenCacheKey) to the
 * wrong credential.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { getHubSpotClientAsync } from '../src/api/hubspot-client.js';
import { __resetAccountManagerForTests } from '../src/modules/accounts/manager.js';

function writeToken(configDir: string, accessToken: string): void {
  writeFileSync(
    join(configDir, 'credentials', 'test-example-com.token.json'),
    JSON.stringify({
      access_token: accessToken,
      refresh_token: 'fake-refresh-token',
      expires_at: Date.now() + 86_400_000,
      hub_id: 12345678,
      user: 'test@example.com',
    }),
  );
}

describe('getHubSpotClientAsync client reuse', () => {
  let configDir: string | undefined;

  afterEach(() => {
    __resetAccountManagerForTests();
    delete process.env.HUBSPOT_CONFIG_DIR;
    delete process.env.HUBSPOT_ACCOUNT_EMAIL;
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    configDir = undefined;
  });

  it('rebuilds the client when the token file changes under the same account', async () => {
    configDir = mkdtempSync(join(tmpdir(), 'hubspot-client-token-change-'));
    mkdirSync(join(configDir, 'credentials'), { recursive: true });
    writeFileSync(
      join(configDir, 'accounts.json'),
      JSON.stringify({ accounts: [{ email: 'test@example.com', hubId: 12345678 }] }),
    );
    writeToken(configDir, 'token-one');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_ACCOUNT_EMAIL = 'test@example.com';
    __resetAccountManagerForTests();

    const first = await getHubSpotClientAsync();
    expect(first.tokenCacheKey).toBe('token-one');

    // Same token -> same instance (the reuse path still holds).
    expect(await getHubSpotClientAsync()).toBe(first);

    // Token file replaced for the same account -> a new client is built.
    writeToken(configDir, 'token-two');
    const rotated = await getHubSpotClientAsync();
    expect(rotated).not.toBe(first);
    expect(rotated.tokenCacheKey).toBe('token-two');
  });
});
