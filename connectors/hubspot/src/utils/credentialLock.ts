import fs from 'node:fs';
import { createRequire } from 'node:module';
import type * as ProperLockfile from 'proper-lockfile';

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

function resolveStaleMs(override?: number): number {
  if (typeof override === 'number') {
    return override;
  }

  const envValue = process.env.HUBSPOT_REFRESH_LOCK_STALE_MS;
  if (!envValue) {
    return DEFAULT_STALE_MS;
  }

  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_STALE_MS;
  }

  return parsed;
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
