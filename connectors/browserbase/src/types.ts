import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const BROWSERBASE_API_BASE = 'https://api.browserbase.com/v1';
export const SERVER_NAME = 'browserbase-mcp-server';
/**
 * Server version reported on MCP `initialize`. Read from package.json so it
 * cannot drift from the published npm version.
 */
export const SERVER_VERSION = pkg.version;

/**
 * Default timeout (ms) for outbound HTTP requests made by this connector.
 *
 * Applies to both upstream API calls and host-bridge calls. 30_000ms is the
 * safe baseline for CRUD / polling-style APIs; long-running waits are
 * implemented as client-side polling loops (see wait_for_agent_run), not as
 * single long HTTP requests.
 *
 * Users can override via the `BROWSERBASE_REQUEST_TIMEOUT_MS` env var.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Sanity ceiling on configured timeouts. 30 minutes is well above any
 * realistic request latency and catches accidental extra zeros in env
 * values (e.g. pasting `1800000000` instead of `180000`).
 */
export const MAX_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Parse a positive integer from an env var. Returns the fallback (with a
 * stderr warning) for missing/empty, non-integer, non-positive, or
 * out-of-range values so misconfiguration is visible rather than silently
 * defaulting.
 */
export function parseTimeoutEnv(envVarName: string, fallbackMs: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw === '') return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.error(
      `[browserbase] Ignoring invalid ${envVarName}=${JSON.stringify(raw)} (expected positive integer ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  if (parsed > MAX_REQUEST_TIMEOUT_MS) {
    console.error(
      `[browserbase] Ignoring ${envVarName}=${parsed} (exceeds max ${MAX_REQUEST_TIMEOUT_MS}ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  return parsed;
}

/**
 * Timeout (ms) for outbound requests. Reads `BROWSERBASE_REQUEST_TIMEOUT_MS`
 * at call time, falling back to `DEFAULT_REQUEST_TIMEOUT_MS`.
 */
export function getRequestTimeoutMs(): number {
  return parseTimeoutEnv('BROWSERBASE_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
}

export interface BridgeState {
  port: number;
  token: string;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}
