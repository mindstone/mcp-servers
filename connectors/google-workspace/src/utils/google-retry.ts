// googleapis consumes gaxios's CommonJS types, whose error has a nominal brand.
import type { GaxiosError, RetryConfig } from 'gaxios' with { 'resolution-mode': 'require' };
import { extractHttpStatus } from './apiError.js';

const TERMINAL_RETRY_DECISION = Symbol.for('google-workspace.terminal-retry-decision');
const RETRY_METHODS = new Set(['GET', 'HEAD', 'PUT', 'OPTIONS', 'DELETE']);
const EXTENDED_RATE_LIMIT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Google's documented exponential backoff caps at 32–64 seconds. Our 32-second
// caps total 95 seconds over seven retries; jitter in [2/3, 1] guarantees at
// least 63 1/3 seconds of waiting, so one attempt follows a full minute window.
const MAX_RATE_LIMIT_RETRIES = 7;
const MAX_RETRY_AFTER_MS = 64_000;
const MAX_BACKOFF_MS = 32_000;
const LONG_WINDOW_QUOTA = /\b(?:dailyLimitExceeded|quotaExceeded)\b|per\s+day/i;
export const GOOGLE_RATE_LIMIT_NEXT_STEP = 'Google Workspace rate limit reached. Back off before retrying, reduce the request size if possible, then try again.';

/** The error's message and response body, where Google puts structured reasons. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
  return `${message}\n${typeof data === 'string' ? data : JSON.stringify(data ?? '')}`;
}

/** Keep Drive's existing daily-quota classification for file-access checks. */
export function rateLimitReason(error: unknown, status: number | undefined): string | undefined {
  if (status !== 403 && status !== 429) return undefined;
  const reason = /\b(?:userRateLimitExceeded|rateLimitExceeded|dailyLimitExceeded)\b/.exec(errorText(error))?.[0];
  return reason ?? (status === 429 ? 'too many requests' : undefined);
}

export function isShortWindowRateLimit(error: unknown): boolean {
  const text = errorText(error);
  const statusMatch = /\bstatus\s+(403|429)\b/i.exec(text);
  const status = extractHttpStatus(error) ?? (statusMatch ? Number(statusMatch[1]) : undefined);
  if (LONG_WINDOW_QUOTA.test(text)) return false;
  return status === 429 || (status === 403 && (
    /\b(?:rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED)\b/.test(text) ||
    /quota exceeded for quota metric[\s\S]*per\s+(?:minute|second|100\s+seconds)/i.test(text)
  ));
}

/** Only this request policy can declare a terminal retry decision. */
export function isGoogleRecoveryExhausted(error: unknown): boolean {
  const seen = new Set<object>();
  while (typeof error === 'object' && error !== null && !seen.has(error)) {
    if ((error as { [TERMINAL_RETRY_DECISION]?: unknown })[TERMINAL_RETRY_DECISION] === true) return true;
    seen.add(error);
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

export function preserveGoogleRetryDecision<T extends object>(target: T, cause: unknown): T {
  if (isGoogleRecoveryExhausted(cause)) Object.defineProperty(target, TERMINAL_RETRY_DECISION, { value: true });
  return target;
}

function retryAfterMs(error: GaxiosError): number {
  // gaxios 7 uses Headers; accept plain objects as well for transport adapters.
  const headers = error.response?.headers as Headers | Record<string, unknown> | undefined;
  const value = headers && 'get' in headers && typeof headers.get === 'function'
    ? headers.get('retry-after')
    : (headers as Record<string, unknown> | undefined)?.['retry-after'];
  if (typeof value !== 'string') return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

export function createGoogleRetryConfig({
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  random = Math.random,
}: {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
} = {}): RetryConfig {
  return {
    shouldRetry(error) {
      if ((error.config.signal?.aborted && error.code !== 'TimeoutError') || error.code === 'AbortError') return false;
      const method = error.config.method?.toUpperCase() ?? 'GET';
      if (!RETRY_METHODS.has(method)) return false;
      const attempt = error.config.retryConfig?.currentRetryAttempt ?? 0;
      if ((extractHttpStatus(error) === 403 || extractHttpStatus(error) === 429) && LONG_WINDOW_QUOTA.test(errorText(error))) return false;
      if (EXTENDED_RATE_LIMIT_METHODS.has(method) && isShortWindowRateLimit(error)) {
        if (attempt >= MAX_RATE_LIMIT_RETRIES || retryAfterMs(error) > MAX_RETRY_AFTER_MS) {
          Object.defineProperty(error, TERMINAL_RETRY_DECISION, { value: true });
          return false;
        }
        return true;
      }
      if (!error.response) return attempt < 2;
      const status = error.response.status;
      return attempt < 3 && ((status >= 100 && status <= 199) || status === 408 ||
        status === 429 || (status >= 500 && status <= 599));
    },
    async retryBackoff(error, gaxiosDelay) {
      const method = error.config.method?.toUpperCase() ?? 'GET';
      if (!EXTENDED_RATE_LIMIT_METHODS.has(method) || !isShortWindowRateLimit(error)) return sleep(gaxiosDelay);
      // gaxios increments currentRetryAttempt BEFORE calling retryBackoff.
      const n = Math.max(0, (error.config.retryConfig?.currentRetryAttempt ?? 1) - 1);
      const cap = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** n);
      await sleep(Math.max(retryAfterMs(error), cap * (2 + random()) / 3));
    },
  };
}
