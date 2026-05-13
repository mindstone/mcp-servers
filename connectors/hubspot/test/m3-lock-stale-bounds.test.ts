import { afterEach, describe, expect, it, vi } from 'vitest';
import logger from '../src/utils/logger.js';
import { resolveStaleMs } from '../src/utils/credentialLock.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('HUBSPOT_REFRESH_LOCK_STALE_MS bounds', () => {
  it('raises a 1ms override to the safe lower bound', () => {
    vi.stubEnv('HUBSPOT_REFRESH_LOCK_STALE_MS', '1');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(resolveStaleMs()).toBeGreaterThanOrEqual(30_000);
    expect(resolveStaleMs()).toBe(70_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ parsedMs: 1, resolvedMs: 70_000 }),
      'hubspot_refresh_lock_stale_ms_bounded',
    );
  });

  it('resolves 60000 to max(override, request timeout + 10000)', () => {
    vi.stubEnv('HUBSPOT_REFRESH_LOCK_STALE_MS', '60000');
    vi.stubEnv('HUBSPOT_REQUEST_TIMEOUT_MS', '80000');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(resolveStaleMs()).toBe(90_000);
  });

  it('accepts the documented 900000ms enterprise-NFS escape hatch', () => {
    vi.stubEnv('HUBSPOT_REFRESH_LOCK_STALE_MS', '900000');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(resolveStaleMs()).toBe(900_000);
  });

  it('caps overrides above the documented escape hatch at 900000', () => {
    vi.stubEnv('HUBSPOT_REFRESH_LOCK_STALE_MS', '900001');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(resolveStaleMs()).toBe(900_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ parsedMs: 900_001, resolvedMs: 900_000 }),
      'hubspot_refresh_lock_stale_ms_bounded',
    );
  });

  it('uses the 90000 default when the env override is missing', () => {
    expect(resolveStaleMs()).toBe(90_000);
  });

  it('uses the 90000 default when the env override is non-numeric', () => {
    vi.stubEnv('HUBSPOT_REFRESH_LOCK_STALE_MS', 'not-a-number');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(resolveStaleMs()).toBe(90_000);
  });
});
