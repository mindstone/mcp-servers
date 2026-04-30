/**
 * Send-side caps and rate-limiting for `email_send`.
 *
 * Defaults are baked in so that hosts which do not set any of the caps env
 * vars still get safe behaviour: 25 combined recipients per message, 50 sends
 * per rolling 60-minute window. Hosts can tighten these via
 * `EMAIL_IMAP_MAX_RECIPIENTS`, `EMAIL_IMAP_RATE_LIMIT_PER_HOUR`, and
 * `EMAIL_IMAP_RATE_LIMIT_WINDOW_MS`.
 *
 * The rate limiter is a simple in-process sliding-window counter keyed off
 * `Date.now()`. It is intentionally per-process: the goal is to act as a
 * blast-radius circuit breaker against prompt-injection-driven mass sends,
 * not to provide cluster-wide quota enforcement.
 */

const RECIPIENT_LIMIT_DEFAULT = 25;
const RATE_LIMIT_PER_HOUR_DEFAULT = 50;
const RATE_LIMIT_WINDOW_MS_DEFAULT = 3_600_000;

function readPositiveInt(envName: string, defaultValue: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === null) {
    return defaultValue;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return defaultValue;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

export function getMaxRecipients(): number {
  // Default 25. Cap on combined To+CC+BCC count per `email_send` call.
  return readPositiveInt('EMAIL_IMAP_MAX_RECIPIENTS', RECIPIENT_LIMIT_DEFAULT);
}

export function getRateLimitPerWindow(): number {
  // Default 50 sends per `EMAIL_IMAP_RATE_LIMIT_WINDOW_MS` (1 hour).
  return readPositiveInt('EMAIL_IMAP_RATE_LIMIT_PER_HOUR', RATE_LIMIT_PER_HOUR_DEFAULT);
}

export function getRateWindowMs(): number {
  // Default 3_600_000 ms (1 hour). Sliding window for the rate limiter.
  return readPositiveInt('EMAIL_IMAP_RATE_LIMIT_WINDOW_MS', RATE_LIMIT_WINDOW_MS_DEFAULT);
}

const sendTimestamps: number[] = [];

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  observed: number;
  resetAt?: string;
  retryAfterMs?: number;
}

/**
 * Check whether a new `email_send` invocation may proceed under the rolling
 * rate limit. Removes expired entries from the sliding window before
 * deciding. Does NOT mutate the recorded-send list; call `recordSend`
 * separately when (and only when) a send is actually attempted/succeeded.
 */
export function checkRateLimit(now: number = Date.now()): RateLimitDecision {
  const limit = getRateLimitPerWindow();
  const windowMs = getRateWindowMs();
  const cutoff = now - windowMs;

  while (sendTimestamps.length > 0 && sendTimestamps[0]! <= cutoff) {
    sendTimestamps.shift();
  }

  if (sendTimestamps.length >= limit) {
    const oldest = sendTimestamps[0]!;
    const resetAtMs = oldest + windowMs;
    const retryAfterMs = Math.max(1, resetAtMs - now);
    return {
      allowed: false,
      limit,
      observed: sendTimestamps.length,
      resetAt: new Date(resetAtMs).toISOString(),
      retryAfterMs,
    };
  }

  return { allowed: true, limit, observed: sendTimestamps.length };
}

/**
 * Record a successful (or attempted) send. The caller decides the policy:
 * the current `email_send` handler records on attempt so that an SMTP
 * transport failure still counts against the budget — this prevents a
 * looped retry from circumventing the rate cap.
 */
export function recordSend(now: number = Date.now()): void {
  sendTimestamps.push(now);
}

/**
 * Test-only helper: reset the in-memory rate-limit ledger. Not exported
 * from the package's public surface; safe to call from internal tests.
 */
export function resetRateLimitState(): void {
  sendTimestamps.length = 0;
}
