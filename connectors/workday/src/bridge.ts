import * as fs from 'fs';
import * as path from 'path';
import { type BridgeState, REQUEST_TIMEOUT_MS } from './types.js';

/**
 * Path to bridge state file, supporting both current and legacy env vars.
 */
export const BRIDGE_STATE_PATH =
  process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE || '';

// The state file is tiny JSON ({ port, token }); refuse anything larger.
const MAX_BRIDGE_STATE_BYTES = 64 * 1024;

const warn = (message: string): void => {
  console.error(`[Workday] ${message}`);
};

/**
 * Load the host-app bridge state file.
 *
 * The path is host-supplied process configuration: the host app writes this
 * file under its own application-data directory, which sits OUTSIDE both
 * approved file-access roots (`MCP_WORKSPACE_PATH` and `os.tmpdir()`), so the
 * canonical-prefix containment of AGENTS.md invariant #5 cannot apply here —
 * containing the read to those roots would break the production host
 * contract. The risk is instead bounded by treating the file as hostile
 * input: lexical path hygiene, open-once + fstat + read-through-fd (no
 * stat-then-read race), a size cap, strict JSON shape validation, and
 * loopback-only use of the result. Every failure is observable via a stderr
 * warning — never silently collapsed to null.
 */
const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;

  if (!path.isAbsolute(BRIDGE_STATE_PATH) || BRIDGE_STATE_PATH.split(/[\\/]/).includes('..')) {
    warn('Ignoring bridge state path that is not an absolute, normalized path.');
    return null;
  }

  let fd: number | undefined;
  try {
    // Open once and validate through the descriptor: no TOCTOU window between
    // a pre-check and the read.
    fd = fs.openSync(BRIDGE_STATE_PATH, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      warn('Ignoring bridge state: path is not a regular file.');
      return null;
    }
    if (stat.size > MAX_BRIDGE_STATE_BYTES) {
      warn(`Ignoring bridge state: file exceeds ${MAX_BRIDGE_STATE_BYTES} bytes.`);
      return null;
    }

    const raw = fs.readFileSync(fd, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warn('Ignoring bridge state: top-level JSON value is not an object.');
      return null;
    }
    const { port, token } = parsed as Record<string, unknown>;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
      warn('Ignoring bridge state: "port" is not an integer in 1-65535.');
      return null;
    }
    if (typeof token !== 'string' || token.length === 0) {
      warn('Ignoring bridge state: "token" is not a non-empty string.');
      return null;
    }

    return { port: port as number, token };
  } catch (error) {
    warn(
      `Failed to load bridge state file; bridge unavailable (${error instanceof Error ? error.name : 'unknown error'}).`,
    );
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Close failure after a successful read is benign; nothing to do.
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
