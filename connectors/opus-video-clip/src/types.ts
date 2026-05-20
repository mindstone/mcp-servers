/**
 * Default timeouts (ms). Three split values — see D7 in the planning doc:
 *  - API timeout for general Opus API calls (CRUD, polling)
 *  - Upload timeout for individual GCS resumable upload chunks
 *  - Bridge timeout for the optional host-app bridge
 *
 * Override via `OPUS_API_TIMEOUT_MS`, `OPUS_UPLOAD_TIMEOUT_MS`,
 * `OPUS_BRIDGE_TIMEOUT_MS` env vars.
 */
export const DEFAULT_API_TIMEOUT_MS = 120_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 600_000;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;

/** Sanity ceiling — 30 minutes. */
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;

function parseTimeoutEnv(envVarName: string, fallbackMs: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw === '') return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.error(
      `[Opus] Ignoring invalid ${envVarName}=${JSON.stringify(raw)} (expected positive integer ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  if (parsed > MAX_TIMEOUT_MS) {
    console.error(
      `[Opus] Ignoring ${envVarName}=${parsed} (exceeds max ${MAX_TIMEOUT_MS}ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  return parsed;
}

export function getApiTimeoutMs(): number {
  return parseTimeoutEnv('OPUS_API_TIMEOUT_MS', DEFAULT_API_TIMEOUT_MS);
}

export function getUploadTimeoutMs(): number {
  return parseTimeoutEnv('OPUS_UPLOAD_TIMEOUT_MS', DEFAULT_UPLOAD_TIMEOUT_MS);
}

export function getBridgeTimeoutMs(): number {
  return parseTimeoutEnv('OPUS_BRIDGE_TIMEOUT_MS', DEFAULT_BRIDGE_TIMEOUT_MS);
}

export interface BridgeState {
  port: number;
  token: string;
}

/**
 * Typed connector error with a stable machine-readable `code` and a
 * human-facing `resolution` hint. The MCP tool wrapper (`withErrorHandling`)
 * serialises these to a structured JSON error response.
 */
export class OpusError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'OpusError';
  }
}

/**
 * Parse a `Retry-After` header value. Per RFC 9110 §10.2.3 it may be either:
 *  - a non-negative integer number of seconds, OR
 *  - an HTTP-date.
 *
 * Returns a non-negative integer seconds-to-wait. Returns `null` on parse
 * failure so callers can fall back to their own backoff strategy.
 */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    return null;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - nowMs) / 1000));
}

// ---------------------------------------------------------------------------
// Opus API response types
// ---------------------------------------------------------------------------

/**
 * Known async-job statuses. The connector treats any unrecognised string as
 * `UPSTREAM_STATUS_UNKNOWN` (observable; not silently collapsed to `pending`).
 *
 * Opus uses two distinct enum sets across its async jobs:
 *  - Censor jobs: `CONCLUDED | FAILED | PROCESSING | QUEUED | UNKNOWN`
 *  - Social copy jobs: `RUNNING | COMPLETED | FAILED`
 *
 * We accept both case-sensitive variants in the classifier below.
 */
export const KNOWN_JOB_STATUSES = [
  'PENDING',
  'QUEUED',
  'RUNNING',
  'PROCESSING',
  'CONCLUDED',
  'COMPLETED',
  'FAILED',
  'UNKNOWN',
] as const;

export type KnownJobStatus = (typeof KNOWN_JOB_STATUSES)[number];

export interface PollableJobResponse {
  status?: string;
  [key: string]: unknown;
}

/**
 * Sharing visibility for `POST /api/clip-projects/{projectId}/update-visibility`.
 * Opus only supports two values; `PUBLIC` makes the project open to anyone, and
 * `DEFAULT` restricts it to team members.
 */
export const SHARE_VISIBILITY = ['DEFAULT', 'PUBLIC'] as const;
export type ShareVisibility = (typeof SHARE_VISIBILITY)[number];

/**
 * Project lifecycle stages, surfaced via `GET /api/clip-projects/{projectId}`.
 */
export const PROJECT_STAGES = [
  'PENDING',
  'QUEUED',
  'IMPORT',
  'CURATE',
  'REFINE',
  'RENDER',
  'UPLOAD',
  'COMPLETE',
  'STALLED',
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];
