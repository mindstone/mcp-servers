import * as fs from 'fs';
import { z } from 'zod';
import { type BridgeState, REQUEST_TIMEOUT_MS } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

/**
 * Path to bridge state file, supporting both current and legacy env vars.
 *
 * Threat-model note (AGENTS.md security invariant #5): this path is
 * host-injected configuration — the host app sets the env var when it spawns
 * this server, and it points at the host's own state directory (NOT
 * `MCP_WORKSPACE_PATH` or `os.tmpdir()`), so workspace containment does not
 * apply the way it does for model-supplied file paths. The model cannot
 * influence this path. The read is still hardened below:
 *
 * - `O_NOFOLLOW` on the open, so a symlinked FINAL path component is refused
 *   atomically (no check-then-use race) on POSIX. Symlinked ANCESTORS stay
 *   allowed on purpose: legitimate host state dirs resolve through symlinks
 *   (e.g. macOS temp dirs under /var -> /private/var).
 * - An `lstat` pre-check plus a post-open canonical cross-check
 *   (realpath inode vs opened-fd inode) for platforms where `O_NOFOLLOW` is
 *   not honoured — a swap raced against the open is detected and refused
 *   rather than silently read.
 * - Same-descriptor fstat + read-through-fd (regular files only; no
 *   check-then-use race on the content itself).
 * - Strict schema validation of the content — a non-integer `port`, for
 *   example, would otherwise be interpolated into the loopback URL and could
 *   redirect the request off-host.
 */
export const BRIDGE_STATE_PATH =
  process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE || '';

const bridgeStateSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
});

export interface BridgeResponse {
  success: boolean;
  warning?: string;
  error?: string;
}

/**
 * The bridge is a loopback HTTP server inside the host app, but its response
 * is still external data at a trust boundary — any local process able to bind
 * the port can answer, so the body is runtime-validated (never a bare cast)
 * and its free-text fields (`warning` / `error`) are enveloped as untrusted
 * content before they can reach model-visible output (AGENTS.md invariants
 * #6 and "validate every external response with Zod").
 */
const bridgeResponseSchema = z.object({
  success: z.boolean(),
  warning: z.string().optional(),
  error: z.string().optional(),
});

const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;
  let fd: number | null = null;
  try {
    // Best-effort pre-check (the atomic refusal is O_NOFOLLOW below; this
    // gives a clear stderr signal and covers platforms without O_NOFOLLOW).
    if (fs.lstatSync(BRIDGE_STATE_PATH).isSymbolicLink()) {
      console.error('[mixmax] bridge state rejected: state path is a symbolic link');
      return null;
    }
    fd = fs.openSync(BRIDGE_STATE_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      console.error('[mixmax] bridge state rejected: not a regular file');
      return null;
    }
    // Detect-and-refuse a swap raced against the open: the canonical path
    // must resolve to the same file we actually opened.
    const canonical = fs.statSync(fs.realpathSync(BRIDGE_STATE_PATH));
    if (canonical.dev !== opened.dev || canonical.ino !== opened.ino) {
      console.error('[mixmax] bridge state rejected: path resolved to a different file than was opened');
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
    // Unreadable, non-JSON, or symlink (ELOOP under O_NOFOLLOW) state file —
    // bridge is simply unavailable; the caller surfaces an observable
    // "Bridge not available" error.
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

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { success: false, error: 'Bridge returned a malformed response' };
  }
  const parsed = bridgeResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { success: false, error: 'Bridge returned an unexpected response shape' };
  }
  // Envelope bridge-supplied free text here, at the boundary, so no caller can
  // surface it raw (injection via `</untrusted-content>` breakout is escaped).
  return {
    success: parsed.data.success,
    ...(parsed.data.warning !== undefined
      ? { warning: wrapUntrusted(parsed.data.warning, 'mixmax:bridge.warning') }
      : {}),
    ...(parsed.data.error !== undefined
      ? { error: wrapUntrusted(parsed.data.error, 'mixmax:bridge.error') }
      : {}),
  };
};
