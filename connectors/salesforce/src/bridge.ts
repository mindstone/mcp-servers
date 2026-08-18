import * as fs from 'node:fs';
import { type BridgeState, REQUEST_TIMEOUT_MS } from './types.js';

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
 * `timeoutMs` defaults to the ordinary per-call budget (REQUEST_TIMEOUT_MS);
 * callers that trigger long host-side flows (e.g. interactive OAuth) can opt
 * into a longer one. The abort itself is never removed — only widened — so a
 * dead bridge still fails within the chosen bound.
 */
export const bridgeRequest = async (
  urlPath: string,
  body: Record<string, unknown> = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ success: boolean; username?: string; warning?: string; error?: string }> => {
  const bridge = loadBridgeState();
  if (!bridge) {
    return { success: false, error: 'Bridge not available' };
  }
  const response = await fetch(`http://127.0.0.1:${bridge.port}${urlPath}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ success: boolean; username?: string; warning?: string; error?: string }>;
};
