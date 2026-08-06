import * as fs from 'fs';
import { z } from 'zod';
import { type BridgeState, REQUEST_TIMEOUT_MS } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

/**
 * Path to bridge state file, supporting both current and legacy env vars.
 */
export const BRIDGE_STATE_PATH =
  process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE || '';

/** Bridge state is a tiny { port, token } JSON document. */
const MAX_BRIDGE_STATE_BYTES = 16 * 1024;

export interface BridgeResponse {
  success: boolean;
  warning?: string;
  error?: string;
}

/**
 * The bridge is a loopback HTTP server inside the host app, but its response
 * is still external data at a trust boundary — any local process able to bind
 * the port can answer, so the body is runtime-validated (never a bare cast)
 * and its free-text fields (`warning` / `error`) are enveloped as untrusted
 * content before they can reach model-visible output (AGENTS.md invariants
 * #6 and "validate every external response with Zod").
 */
const bridgeResponseSchema = z.object({
  success: z.boolean(),
  warning: z.string().optional(),
  error: z.string().optional(),
});

const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;
  // Open once, fstat the descriptor, and read through it: the file cannot be
  // swapped (or replaced by a symlink target) between check and use, and a
  // non-regular or oversized file is refused. The parsed shape is validated
  // before use (integer port 1-65535, non-empty token) so a crafted port can
  // never re-interpret the request URL authority and send the bearer token
  // off-host. Failures are observable on stderr rather than silently treated
  // as "no bridge".
  let fd: number;
  try {
    fd = fs.openSync(BRIDGE_STATE_PATH, 'r');
  } catch {
    console.error('[talentlms] Bridge state file is not readable; continuing without the bridge.');
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BRIDGE_STATE_BYTES) {
      console.error('[talentlms] Bridge state file is not a regular file of expected size; ignoring it.');
      return null;
    }
    const raw = fs.readFileSync(fd, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const candidate = parsed as Partial<BridgeState> | null;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !Number.isInteger(candidate.port) ||
      (candidate.port as number) < 1 ||
      (candidate.port as number) > 65535 ||
      typeof candidate.token !== 'string' ||
      candidate.token.length === 0
    ) {
      console.error('[talentlms] Bridge state file has an unexpected shape; ignoring it.');
      return null;
    }
    return { port: candidate.port as number, token: candidate.token };
  } catch {
    console.error('[talentlms] Bridge state file could not be parsed; continuing without the bridge.');
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
};

/**
 * Send a request to the host app bridge.
 *
 * The bridge is an HTTP server running inside the host app (e.g. the host application)
 * that handles credential management and other cross-process operations.
 */
export const bridgeRequest = async (
  urlPath: string,
  body: Record<string, unknown>,
): Promise<BridgeResponse> => {
  const bridge = loadBridgeState();
  if (!bridge) {
    return { success: false, error: 'Bridge not available' };
  }
  const response = await fetch(`http://127.0.0.1:${bridge.port}${urlPath}`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401 || response.status === 403) {
    return { success: false, error: `Bridge returned ${response.status}: unauthorized. Check host app authentication.` };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return {
      success: false,
      error: `Bridge returned a malformed response (HTTP ${response.status}).`,
    };
  }
  const parsed = bridgeResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      error: `Bridge returned an unexpected response shape (HTTP ${response.status}).`,
    };
  }
  // Envelope bridge-supplied free text here, at the boundary, so no caller can
  // surface it raw (injection via `</untrusted-content>` breakout is escaped).
  return {
    success: parsed.data.success,
    ...(parsed.data.warning !== undefined
      ? { warning: wrapUntrusted(parsed.data.warning, 'talentlms:bridge.warning') }
      : {}),
    ...(parsed.data.error !== undefined
      ? { error: wrapUntrusted(parsed.data.error, 'talentlms:bridge.error') }
      : {}),
  };
};
