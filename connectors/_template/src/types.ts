/**
 * Default timeout (ms) for outbound HTTP requests made by this connector.
 *
 * Applies to both upstream API calls and host-bridge calls. Individual
 * connectors with very long synchronous HTTP calls (e.g. direct image or
 * video generation rather than async task polling) may want to raise this
 * or split client vs bridge timeouts — see `connectors/nano-banana` for a
 * worked example. 30_000ms is the safe baseline for CRUD / polling-style
 * APIs.
 *
 * Users can override via the `{CONNECTOR_NAME}_REQUEST_TIMEOUT_MS` env var
 * (rename per connector), e.g. `ELEVENLABS_REQUEST_TIMEOUT_MS=60000`.
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
 *
 * When scaffolding a new connector from this template, rename `envVarName`
 * to match the connector (e.g. `ELEVENLABS_REQUEST_TIMEOUT_MS`).
 */
export function parseTimeoutEnv(envVarName: string, fallbackMs: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw === '') return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.error(
      `[connector] Ignoring invalid ${envVarName}=${JSON.stringify(raw)} (expected positive integer ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  if (parsed > MAX_REQUEST_TIMEOUT_MS) {
    console.error(
      `[connector] Ignoring ${envVarName}=${parsed} (exceeds max ${MAX_REQUEST_TIMEOUT_MS}ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  return parsed;
}

/**
 * Timeout (ms) for outbound requests. Reads the connector-specific env var
 * at call time, falling back to `DEFAULT_REQUEST_TIMEOUT_MS`.
 *
 * When scaffolding a new connector, replace `CONNECTOR_REQUEST_TIMEOUT_MS`
 * with `{CONNECTOR_NAME}_REQUEST_TIMEOUT_MS`.
 */
export function getRequestTimeoutMs(): number {
  return parseTimeoutEnv('CONNECTOR_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
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
