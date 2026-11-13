import * as fs from 'fs';
import { z } from 'zod';
import { type BridgeState, EmailImapError, REQUEST_TIMEOUT_MS } from './types.js';

// Unknown fields (e.g. a host's `message`) are allowed and dropped.
const BridgeResponseSchema = z.object({
  success: z.boolean(),
  warning: z.string().optional(),
  error: z.string().optional(),
});

export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

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

  const unexpectedFormat = () =>
    new EmailImapError(
      'The host app bridge returned a response in an unexpected format.',
      'BRIDGE_ERROR',
      'The host app may be out of date with this connector. Update the host app and try again.',
    );

  let reply: unknown;
  try {
    reply = await response.json();
  } catch (error) {
    // Only a body that is not JSON is an unexpected format; a read failure
    // (connection dropped, timeout) propagates as an unreachable bridge.
    if (error instanceof SyntaxError) {
      throw unexpectedFormat();
    }
    throw error;
  }
  const parsed = BridgeResponseSchema.safeParse(reply);
  if (!parsed.success) {
    throw unexpectedFormat();
  }
  return parsed.data;
};
