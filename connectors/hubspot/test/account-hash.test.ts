import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAccountHashWarningForTests,
  deriveHubSpotAccountHash,
  MISSING_ACCOUNT_HASH_SALT,
} from '../src/utils/accountHash.js';
import logger from '../src/utils/logger.js';

const TEST_EMAIL = 'Owner@Example.com';
const TEST_SALT_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const HOST_REFERENCE_VECTORS = [
  {
    email: 'Owner@Example.com',
    saltHex: TEST_SALT_HEX,
    digest: '31577483a2bf6d44cc8f31d6069d17e6a02b96bbe84c0e6c245ae7dfef66b2fe',
  },
  {
    email: 'jane+eu@example.com',
    saltHex: TEST_SALT_HEX,
    digest: 'b1516314d3c55650f3a5b2bf6e809121418106296e30d915c08bcd5c94dd35d0',
  },
  {
    email: 'UPPER.lower-123@Example.Org',
    saltHex: TEST_SALT_HEX,
    digest: 'cac6ca2a717202ddf8fd18d041be3b106bd04a90c60bf09640ceda8593030116',
  },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  __resetAccountHashWarningForTests();
  delete process.env.HUBSPOT_TELEMETRY_SALT;
});

describe('deriveHubSpotAccountHash', () => {
  it('matches host helper reference vectors for known email + salt inputs', () => {
    for (const vector of HOST_REFERENCE_VECTORS) {
      process.env.HUBSPOT_TELEMETRY_SALT = vector.saltHex;
      const hash = deriveHubSpotAccountHash(vector.email);
      expect(hash).toBe(vector.digest);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('fails closed and emits one missing-salt warning when HUBSPOT_TELEMETRY_SALT is empty', () => {
    process.env.HUBSPOT_TELEMETRY_SALT = '';
    const warnSpy = vi.spyOn(logger, 'warn');

    const first = deriveHubSpotAccountHash(TEST_EMAIL);
    const second = deriveHubSpotAccountHash(TEST_EMAIL);

    expect(first).toBe(MISSING_ACCOUNT_HASH_SALT);
    expect(second).toBe(MISSING_ACCOUNT_HASH_SALT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith({ reason: 'salt-missing' }, 'account_hash_degraded');
  });

  it('fails closed and emits one malformed-salt warning when HUBSPOT_TELEMETRY_SALT is not 64-char hex', () => {
    process.env.HUBSPOT_TELEMETRY_SALT = 'not-a-hex-salt';
    const warnSpy = vi.spyOn(logger, 'warn');

    const first = deriveHubSpotAccountHash(TEST_EMAIL);
    const second = deriveHubSpotAccountHash(TEST_EMAIL);

    expect(first).toBe(MISSING_ACCOUNT_HASH_SALT);
    expect(second).toBe(MISSING_ACCOUNT_HASH_SALT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith({ reason: 'salt-malformed' }, 'account_hash_degraded');
  });
});
