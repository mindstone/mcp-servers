import * as fs from 'fs';
import { type BridgeState, getBridgeTimeoutMs, OpusError } from './types.js';

/**
 * Path to bridge state file, supporting both the current and legacy env vars.
 *
 * The bridge is an OPTIONAL HTTP server running inside the host app (e.g.
 * Mindstone Rebel) that handles credential management and other
 * cross-process operations. When unset, the connector falls back to
 * in-memory credential storage for the current process lifetime.
 */
export const BRIDGE_STATE_PATH =
  process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE || '';

const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;
  try {
    const raw = fs.readFileSync(BRIDGE_STATE_PATH, 'utf8');
    return JSON.parse(raw) as BridgeState;
  } catch {
    return null;
  }
};

export type BridgeResult = { success: boolean; warning?: string; error?: string };

/**
 * Send a request to the host app bridge. Three distinct failure modes
 * surface as typed `OpusError`s so callers (and downstream MCP clients) can
 * distinguish them:
 *
 *  - `BRIDGE_UNAVAILABLE`  — no state file configured / unreadable
 *  - `BRIDGE_UNREACHABLE`  — network error or timeout reaching 127.0.0.1
 *  - `BRIDGE_AUTH_FAILED`  — bridge returned 401 / 403
 */
export const bridgeRequest = async (
  urlPath: string,
  body: Record<string, unknown>,
): Promise<BridgeResult> => {
  const bridge = loadBridgeState();
  if (!bridge) {
    throw new OpusError(
      'Host bridge not configured',
      'BRIDGE_UNAVAILABLE',
      'Set MCP_HOST_BRIDGE_STATE to the bridge state file path, or call the configure tool again without expecting bridge persistence.',
    );
  }

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${bridge.port}${urlPath}`, {
      method: 'POST',
      signal: AbortSignal.timeout(getBridgeTimeoutMs()),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bridge.token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new OpusError(
      `Could not reach host bridge: ${error instanceof Error ? error.message : String(error)}`,
      'BRIDGE_UNREACHABLE',
      'Ensure the host app is running. If the bridge state file is stale, restart the host.',
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new OpusError(
      `Host bridge returned ${response.status} (unauthorized)`,
      'BRIDGE_AUTH_FAILED',
      'Re-acquire the bridge token from the host app and refresh MCP_HOST_BRIDGE_STATE.',
    );
  }

  return response.json() as Promise<BridgeResult>;
};
