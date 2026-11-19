import { logError, redactCredentials } from './key-filter.js';

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
    logError(
      `[Opus] Ignoring invalid ${envVarName}=${JSON.stringify(raw)} (expected positive integer ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  if (parsed > MAX_TIMEOUT_MS) {
    logError(
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
 * Which kind of request failed, so the fixed error text can say what to do
 * next. A request that started an Opus job may have created it even when no
 * complete response came back.
 */
export type RequestKind = 'request' | 'status_check';

/**
 * Fixed text for a request to OpusClip that failed without an HTTP response.
 * The underlying error text can quote anything (headers, URLs, the key), so
 * it never reaches a tool result.
 */
export function opusNetworkError(kind: RequestKind = 'request'): OpusError {
  return new OpusError(
    'Could not get a complete response from OpusClip.',
    'NETWORK_ERROR',
    kind === 'status_check'
      ? 'Check your internet connection, then try the status check again.'
      : 'Check your internet connection. If you were starting a job, check OpusClip for an existing job before submitting it again.',
  );
}

/** Fixed text for a successful (2xx) OpusClip response whose body is not readable JSON. */
export function opusParseError(kind: RequestKind = 'request'): OpusError {
  return new OpusError(
    'OpusClip returned a response this connector could not read.',
    'PARSE_ERROR',
    kind === 'status_check'
      ? 'Try the status check again.'
      : 'If you were starting a job, check OpusClip for an existing job before submitting it again.',
  );
}

/** Error text for stderr: no credential seen this session appears in it. */
export function describeForLog(error: unknown): string {
  return redactCredentials(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
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
