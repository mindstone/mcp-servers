export function isTooManyOpenFilesError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EMFILE' || code === 'ENFILE';
}

export type EmfileRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
};

/**
 * Single-attempt synchronous retry for EMFILE/ENFILE errors.
 */
export function withSingleSyncRetryOnEmfile<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (isTooManyOpenFilesError(error)) {
      return fn();
    }
    throw error;
  }
}

/**
 * Async retry helper for EMFILE/ENFILE errors.
 */
export async function withRetryOnEmfile<T>(
  fn: () => Promise<T>,
  options: EmfileRetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 25,
    maxDelayMs = 250,
    random = Math.random,
  } = options;

  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be >= 1');
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isTooManyOpenFilesError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const expBackoff = baseDelayMs * Math.pow(2, attempt - 1);
      const capped = Math.min(expBackoff, maxDelayMs);
      const jitterRatio = 0.25;
      const jitter = (random() - 0.5) * 2 * jitterRatio * capped;
      const delayMs = Math.max(0, Math.round(capped + jitter));

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
