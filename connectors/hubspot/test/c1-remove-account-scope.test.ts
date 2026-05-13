import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRemoveAccount } from '../src/tools/account-handlers.js';
import {
  __resetAccountManagerForTests,
  sanitizeEmail,
} from '../src/modules/accounts/manager.js';
import logger from '../src/utils/logger.js';
import { deriveHubSpotAccountHash } from '../src/utils/accountHash.js';

const CONFIGURED_EMAIL = 'configured@example.com';
const TEST_TELEMETRY_SALT_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function createConfigDir(email = CONFIGURED_EMAIL): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-c1-remove-'));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({ accounts: [{ email, hubId: 12345678 }] }),
  );
  writeFileSync(
    join(configDir, 'credentials', `${sanitizeEmail(email)}.token.json`),
    JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 86_400_000,
      hub_id: 12345678,
      user: email,
      schemaVersion: 1,
    }),
  );
  return configDir;
}

function parseToolResponse(result: Awaited<ReturnType<typeof handleRemoveAccount>>): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetAccountManagerForTests();
  delete process.env.HUBSPOT_CONFIG_DIR;
  delete process.env.HUBSPOT_ACCOUNT_EMAIL;
  delete process.env.HUBSPOT_TELEMETRY_SALT;
});

describe('remove_hubspot_account scope checks', () => {
  it('rejects attempts to remove a foreign account', async () => {
    const configDir = createConfigDir();
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_ACCOUNT_EMAIL = CONFIGURED_EMAIL;

    const result = await handleRemoveAccount({ email: 'other@example.com' });
    const payload = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      status: 'error',
      errorCode: 'WRONG_ACCOUNT',
      message: 'Can only remove the configured account.',
    });
    expect(existsSync(join(configDir, 'credentials', `${sanitizeEmail(CONFIGURED_EMAIL)}.token.json`))).toBe(true);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('removes the configured account and logs only its derived account hash', async () => {
    const configDir = createConfigDir();
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_ACCOUNT_EMAIL = CONFIGURED_EMAIL;
    process.env.HUBSPOT_TELEMETRY_SALT = TEST_TELEMETRY_SALT_HEX;
    __resetAccountManagerForTests();

    const infoSpy = vi.spyOn(logger, 'info');

    const result = await handleRemoveAccount({ email: CONFIGURED_EMAIL });
    const payload = parseToolResponse(result);

    expect(result.isError).toBeUndefined();
    expect(payload).toMatchObject({
      status: 'success',
      message: 'Successfully disconnected the configured HubSpot account.',
    });
    expect(existsSync(join(configDir, 'credentials', `${sanitizeEmail(CONFIGURED_EMAIL)}.token.json`))).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(
      { account: deriveHubSpotAccountHash(CONFIGURED_EMAIL) },
      'account_removed',
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(CONFIGURED_EMAIL);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('keeps the existing missing-email validation error unchanged', async () => {
    const configDir = createConfigDir();
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_ACCOUNT_EMAIL = CONFIGURED_EMAIL;

    const result = await handleRemoveAccount({});
    const payload = parseToolResponse(result);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      status: 'error',
      message: 'Email address is required to remove an account.',
    });
    expect(payload.errorCode).toBeUndefined();

    rmSync(configDir, { recursive: true, force: true });
  });
});
