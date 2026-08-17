import * as fs from 'fs';
import { type BridgeState, getRequestTimeoutMs } from './types.js';

/**
 * Path to bridge state file, supporting both current and legacy env vars.
 */
export const BRIDGE_STATE_PATH =
  process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE || '';

/**
 * Bridge configure endpoint, set by the host app when spawning the connector.
 * The host controls the path format — the connector never hardcodes it.
 */
const BRIDGE_CONFIGURE_ENDPOINT = process.env.MCP_BRIDGE_CONFIGURE_ENDPOINT || '';

const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;
  try {
    const raw = fs.readFileSync(BRIDGE_STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * Send a request to the host app bridge at an arbitrary path.
 *
 * The bridge is an HTTP server running inside the host app
 * that handles credential management and other cross-process operations.
 */
const bridgeRequest = async (
  urlPath: string,
  body: Record<string, unknown>,
): Promise<{ success: boolean; warning?: string; error?: string }> => {
  const bridge = loadBridgeState();
  if (!bridge) {
    return { success: false, error: 'Bridge not available' };
  }
  const response = await fetch(`http://127.0.0.1:${bridge.port}${urlPath}`, {
    method: 'POST',
    signal: AbortSignal.timeout(getRequestTimeoutMs()),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ success: boolean; warning?: string; error?: string }>;
};

/**
 * Post a credential configuration request to the host app bridge.
 *
 * Uses the MCP_BRIDGE_CONFIGURE_ENDPOINT env var set by the host.
 * Returns `{ success: false }` if the bridge or endpoint is not configured.
 */
export const postToBridge = async (
  body: Record<string, unknown>,
): Promise<{ success: boolean; warning?: string; error?: string }> => {
  if (!BRIDGE_CONFIGURE_ENDPOINT) {
    return { success: false, error: 'Bridge configure endpoint not set' };
  }
  return bridgeRequest(BRIDGE_CONFIGURE_ENDPOINT, body);
};
