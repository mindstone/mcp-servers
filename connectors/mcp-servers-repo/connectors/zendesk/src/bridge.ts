// Bridge env var (MCP_HOST_BRIDGE_STATE || MINDSTONE_REBEL_BRIDGE_STATE) is defined in auth.ts and imported as BRIDGE_STATE_PATH.
import * as fs from 'fs';
import { type BridgeState, REQUEST_TIMEOUT_MS } from './types.js';
import { BRIDGE_STATE_PATH } from './auth.js';

const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;
  try {
    const raw = fs.readFileSync(BRIDGE_STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const bridgeRequest = async (
  urlPath: string,
  body: Record<string, unknown>
): Promise<{ success: boolean; warning?: string; error?: string }> => {
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
  return response.json() as Promise<{ success: boolean; warning?: string; error?: string }>;
};
