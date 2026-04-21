import * as fs from 'fs';
import { type BridgeState, getBridgeRequestTimeoutMs } from './types.js';

/**
 * Path to bridge state file, supporting both current and legacy env vars.
 */
export const BRIDGE_STATE_PATH =
  process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE || '';

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
 * Send a request to the host app bridge.
 *
 * The bridge is an HTTP server running inside the host app (e.g. the host application)
 * that handles credential management and other cross-process operations.
 */
export const bridgeRequest = async (
  urlPath: string,
  body: Record<string, unknown>,
): Promise<{ success: boolean; warning?: string; error?: string }> => {
  const bridge = loadBridgeState();
  if (!bridge) {
    return { success: false, error: 'Bridge not available' };
  }
  const response = await fetch(`http://127.0.0.1:${bridge.port}${urlPath}`, {
    method: 'POST',
    signal: AbortSignal.timeout(getBridgeRequestTimeoutMs()),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401 || response.status === 403) {
    return { success: false, error: `Bridge returned ${response.status}: unauthorized. Check host app authentication.` };
  }

  return response.json() as Promise<{ success: boolean; warning?: string; error?: string }>;
};
