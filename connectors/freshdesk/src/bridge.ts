import * as fs from 'fs';
import { z } from 'zod';
import { type BridgeState, REQUEST_TIMEOUT_MS } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

/**
 * Path to bridge state file, supporting both current and legacy env vars.
 */
export const BRIDGE_STATE_PATH =
  process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE || '';

/**
 * The bridge state file is host-app-controlled input: validate before the
 * port is interpolated into a loopback URL — a non-integer port (e.g.
 * `"80@attacker.example"`) would redirect the request, and its plaintext API
 * key + bearer token payload, off-host. A violation surfaces as the
 * observable "Bridge not available" error.
 */
const bridgeStateSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
});

const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;
  try {
    const raw = fs.readFileSync(BRIDGE_STATE_PATH, 'utf8');
    const parsed = bridgeStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
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

  // A non-JSON body is bridge-controlled: the native parse error can quote
  // fragments of that body, so convert it to a fixed, connector-authored
  // error (same standard the Freshdesk client sets for vendor responses).
  let result: { success: boolean; warning?: string; error?: string };
  try {
    result = (await response.json()) as { success: boolean; warning?: string; error?: string };
  } catch {
    return { success: false, error: 'Bridge returned an unparseable response' };
  }

  // Bridge-authored warning/error text reaches model-visible output, so it
  // goes inside an untrusted-content envelope.
  return {
    success: result.success,
    warning: typeof result.warning === 'string' ? wrapUntrusted(result.warning, 'external-bridge') : undefined,
    error: typeof result.error === 'string' ? wrapUntrusted(result.error, 'external-bridge') : undefined,
  };
};
