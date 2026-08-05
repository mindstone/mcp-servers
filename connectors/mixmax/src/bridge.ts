import * as fs from 'fs';
import { z } from 'zod';
import { type BridgeState, REQUEST_TIMEOUT_MS } from './types.js';

/**
 * Path to bridge state file, supporting both current and legacy env vars.
 *
 * Threat-model note (AGENTS.md security invariant #5): this path is
 * host-injected configuration — the host app sets the env var when it spawns
 * this server, and it points at the host's own state directory (NOT
 * `MCP_WORKSPACE_PATH` or `os.tmpdir()`), so workspace containment does not
 * apply the way it does for model-supplied file paths. The read is still
 * hardened below: open-once + fstat + read-through-fd (no check-then-use
 * race, regular files only) and strict schema validation of the content —
 * a non-integer `port`, for example, would otherwise be interpolated into
 * the loopback URL and could redirect the request off-host.
 */
export const BRIDGE_STATE_PATH =
  process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE || '';

const bridgeStateSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
});

const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(BRIDGE_STATE_PATH, 'r');
    if (!fs.fstatSync(fd).isFile()) {
      console.error('[mixmax] bridge state rejected: not a regular file');
      return null;
    }
    const raw = fs.readFileSync(fd, 'utf8');
    const parsed = bridgeStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.error('[mixmax] bridge state rejected: content failed schema validation');
      return null;
    }
    return parsed.data;
  } catch {
    // Unreadable or non-JSON state file — bridge is simply unavailable; the
    // caller surfaces an observable "Bridge not available" error.
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
};

/**
 * Send a request to the host app bridge.
 *
 * The bridge is an HTTP server running inside the host app (e.g. the host application)
 * that handles credential management and other cross-process operations.
 * Always loopback-only (127.0.0.1) per AGENTS.md security invariant #4.
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

  return response.json() as Promise<{ success: boolean; warning?: string; error?: string }>;
};
