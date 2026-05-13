import fs from 'node:fs';
import { createRequire } from 'node:module';
import type * as ProperLockfile from 'proper-lockfile';
import logger from './logger.js';

const require = createRequire(import.meta.url);
const properLockfile: typeof ProperLockfile = require('proper-lockfile');

interface CompromiseTracker { error?: Error; }

export interface CredentialLockOptions {
  staleMs?: number;
  updateMs?: number;
  retries?: { retries: number; minTimeout: number; maxTimeout: number };
  realpath?: boolean;
}

const DEFAULT_STALE_MS = 90_000;
const DEFAULT_UPDATE_MS = 5_000;
const DEFAULT_RETRIES = { retries: 5, minTimeout: 100, maxTimeout: 500 };
const DEFAULT_HUBSPOT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_HUBSPOT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_ENV_STALE_MS = 30_000;
const MAX_ENV_STALE_MS = 900_000;

function resolveRequestTimeoutMsForLockBound(envValue = process.env.HUBSPOT_REQUEST_TIMEOUT_MS): number {
  if (!envValue || envValue.trim().length === 0) {
    return DEFAULT_HUBSPOT_REQUEST_TIMEOUT_MS;
  }

  if (!/^\d+$/.test(envValue)) {
    return DEFAULT_HUBSPOT_REQUEST_TIMEOUT_MS;
  }

  const parsed = Number(envValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_HUBSPOT_REQUEST_TIMEOUT_MS) {
    return DEFAULT_HUBSPOT_REQUEST_TIMEOUT_MS;
  }

  return parsed;
}

export function resolveStaleMs(override?: number): number {
  if (typeof override === 'number') {
    return override;
  }

  const envValue = process.env.HUBSPOT_REFRESH_LOCK_STALE_MS;
  if (!envValue) {
    return DEFAULT_STALE_MS;
  }

  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { envValue, fallbackMs: DEFAULT_STALE_MS },
      'hubspot_refresh_lock_stale_ms_invalid',
    );
    return DEFAULT_STALE_MS;
  }

  const minStaleMs = Math.max(
    parsed,
    resolveRequestTimeoutMsForLockBound() + 10_000,
    MIN_ENV_STALE_MS,
  );
  const boundedStaleMs = Math.min(minStaleMs, MAX_ENV_STALE_MS);

  if (boundedStaleMs !== parsed) {
    logger.warn(
      {
        envValue,
        parsedMs: parsed,
        resolvedMs: boundedStaleMs,
        minMs: Math.max(resolveRequestTimeoutMsForLockBound() + 10_000, MIN_ENV_STALE_MS),
        maxMs: MAX_ENV_STALE_MS,
      },
      'hubspot_refresh_lock_stale_ms_bounded',
    );
  }

  return boundedStaleMs;
}

export class RefreshLockFailedError extends Error {
  constructor(
    public readonly tokenPath: string,
    message = `Failed to acquire credential lock for ${tokenPath}`,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RefreshLockFailedError';
  }
}

export class LockReleaseFailedError extends RefreshLockFailedError {
  constructor(tokenPath: string, cause?: unknown) {
    super(tokenPath, `Failed to release credential lock for ${tokenPath}`, cause);
    this.name = 'LockReleaseFailedError';
  }
}

// Deadlock prevention invariant for HubSpot credential writes:
// acquire accounts.json lock first, then per-account token lock(s), and release in reverse order.
export async function withHubSpotCredentialLock<T>(
  tokenPath: string,
  fn: (assertLockHealthy: () => void) => Promise<T>,
  opts: CredentialLockOptions = {},
): Promise<T> {
  const tracker: CompromiseTracker = {};
  let release: (() => Promise<void>) | undefined;
  let primaryError: unknown;

  try {
    const releaseFn = await properLockfile.lock(tokenPath, {
      stale: resolveStaleMs(opts.staleMs),
      update: opts.updateMs ?? DEFAULT_UPDATE_MS,
      retries: opts.retries ?? DEFAULT_RETRIES,
      realpath: opts.realpath ?? false,
      onCompromised: (err: Error) => { tracker.error = err; },
    });
    release = async () => {
      await releaseFn();
    };
  } catch (error) {
    throw new RefreshLockFailedError(tokenPath, undefined, error);
  }

  try {
    const lockDirPath = `${tokenPath}.lock`;
    const assertLockHealthy = (): void => {
      if (tracker.error) {
        throw new RefreshLockFailedError(
          tokenPath,
          `Credential lock was compromised for ${tokenPath}`,
          tracker.error,
        );
      }
      if (!fs.existsSync(lockDirPath)) {
        throw new RefreshLockFailedError(
          tokenPath,
          `Credential lock directory disappeared for ${tokenPath}`,
          new Error(`Lock directory missing: ${lockDirPath}`),
        );
      }
    };

    assertLockHealthy();
    const result = await fn(assertLockHealthy);
    assertLockHealthy();
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (release) {
      try {
        await release();
      } catch (releaseError) {
        if (primaryError === undefined) {
          throw new LockReleaseFailedError(tokenPath, releaseError);
        }
      }
    }
  }
}
