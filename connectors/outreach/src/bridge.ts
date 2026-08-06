import * as fs from 'node:fs';
import { z } from 'zod';
import { type BridgeState, REQUEST_TIMEOUT_MS } from './types.js';

/**
 * Path to bridge state file, supporting both current and legacy env vars.
 */
export const BRIDGE_STATE_PATH =
  process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE || '';

// The state file is external input read from disk — validate it (repo
// convention: Zod at boundaries). A non-integer `port` (e.g. a string like
// "8080@evil.example") would otherwise be interpolated into the URL below
// and could redirect the request — and its bearer token — off-loopback.
// The host writes `port` as a JSON number today; a numeric string is accepted
// and coerced so a host-side serialisation change doesn't silently degrade the
// connector to "Bridge not available". Non-numeric strings coerce to NaN and
// are rejected by the int check.
const bridgeStateSchema = z.object({
  port: z
    .union([z.number(), z.string()])
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
  token: z.string().min(1),
});

const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;
  try {
    const raw = fs.readFileSync(BRIDGE_STATE_PATH, 'utf8');
    return bridgeStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
};

/**
 * Send a request to the host app bridge.
 *
 * The bridge is an HTTP server running inside the host app that handles
 * credential management and other cross-process operations.
 */
export const bridgeRequest = async (
  urlPath: string,
  body: Record<string, unknown> = {},
): Promise<{ success: boolean; username?: string; warning?: string; error?: string }> => {
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
  return response.json() as Promise<{ success: boolean; username?: string; warning?: string; error?: string }>;
};
