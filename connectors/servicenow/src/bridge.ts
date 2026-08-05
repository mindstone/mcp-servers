import * as fs from 'fs';
import { z } from 'zod';
import { type BridgeState, REQUEST_TIMEOUT_MS } from './types.js';

/**
 * Path to bridge state file, supporting both current and legacy env vars.
 */
export const BRIDGE_STATE_PATH =
  process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE || '';

/** A bridge state file is a tiny JSON document; anything larger is hostile. */
const MAX_BRIDGE_STATE_BYTES = 64 * 1024;

/**
 * Runtime shape of the bridge state file. The port MUST be a bounded integer:
 * it is interpolated into the request URL, so a non-numeric value (e.g.
 * "80@evil.example") would re-interpret the URL authority and send the bridge
 * bearer token off-host.
 */
const BridgeStateSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
});

/** Runtime shape of a bridge response — never trusted unchecked. */
const BridgeResponseSchema = z.object({
  success: z.boolean(),
  warning: z.string().optional(),
  error: z.string().optional(),
});

/** Bridge failures are observable (stderr), never silently swallowed. */
const warnBridge = (message: string): void => {
  console.error(`[servicenow] bridge state rejected: ${message}`);
};

const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;
  let fd: number | null = null;
  try {
    // Open once and read through the file descriptor: there is no
    // check-then-use window where the file could be swapped between a check
    // and the read, and O_NOFOLLOW refuses a symlink planted at the path.
    fd = fs.openSync(BRIDGE_STATE_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      warnBridge('not a regular file');
      return null;
    }
    if (stat.size > MAX_BRIDGE_STATE_BYTES) {
      warnBridge(`exceeds ${MAX_BRIDGE_STATE_BYTES} bytes`);
      return null;
    }
    const raw = fs.readFileSync(fd, 'utf8');
    const parsed = BridgeStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      warnBridge('unexpected shape (expected integer port 1-65535 and non-empty token)');
      return null;
    }
    return parsed.data;
  } catch (error) {
    warnBridge(error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // close failure leaves nothing to act on
      }
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
): Promise<{ success: boolean; warning?: string; error?: string }> => {
  if (!urlPath.startsWith('/')) {
    throw new Error(`bridgeRequest urlPath must be an absolute path, got: ${urlPath}`);
  }
  const bridge = loadBridgeState();
  if (!bridge) {
    return { success: false, error: 'Bridge not available' };
  }
  // bridge.port is a Zod-validated integer, so the URL authority cannot be
  // re-interpreted; the host is pinned to loopback.
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

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { success: false, error: `Bridge returned a non-JSON response (HTTP ${response.status}).` };
  }
  const result = BridgeResponseSchema.safeParse(parsed);
  if (!result.success) {
    return { success: false, error: `Bridge returned an unexpected response shape (HTTP ${response.status}).` };
  }
  return result.data;
};
