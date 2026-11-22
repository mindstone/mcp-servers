/**
 * Hardened reader for the host app bridge (canonical copy).
 *
 * Connectors cannot import the test-harness at runtime (it is a dev-only
 * `file:` dependency, never published into a connector's `dist/`), so each
 * connector that talks to the bridge carries a VENDORED copy of this file at
 * `connectors/<name>/src/bridge-reader.ts`, byte-identical to this one.
 * `scripts/check-bridge-reader.mjs` fails CI when a copy drifts, and when a
 * connector reads the bridge any other way. Change this file, then copy it to
 * every connector that vendors it, in the same change.
 *
 * The host app sets the state file path when it spawns the server; the model
 * cannot influence it. The read is still hardened, because the file carries the
 * bridge bearer token and its `port` is put into the request URL. The
 * filesystem checks (symlink, FIFO, regular file, inode cross-check, a 64 KiB
 * cap) live in `hardened-json-file.ts`, vendored beside this file and
 * drift-checked the same way. The schema is strict: the token must be visible
 * ASCII, so it can never make the `Authorization` header invalid: fetch would
 * quote the whole header value in its error.
 *
 * Any local process able to bind the port can answer a request, and would
 * receive the token and the request body; nothing here can detect that, so it
 * rests on the host app owning the port. The reply is therefore schema-checked,
 * never cast, and its free text (`username`, `warning`, `error`) is enveloped
 * before it can reach the model; an empty or absent text field stays absent, so
 * a caller's own fallback text still applies. Each refusal logs one fixed stderr
 * line; file content and error messages (which can quote the path) are never
 * logged.
 *
 * `isBridgeConfigured` is the one way for a connector to ask whether it runs
 * under the host app (for example, to pick its auth mode) without naming the env
 * vars itself. It means "a bridge state path is configured", not "the bridge is
 * readable or reachable": `postToBridge` still validates the file on every call.
 */
import { z } from 'zod';
import { readHardenedJsonFile } from './hardened-json-file.js';
import { wrapUntrusted } from './untrusted-content.js';

export const MAX_BRIDGE_STATE_BYTES = 64 * 1024;

const bridgeStateSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[\x21-\x7e]+$/),
});

export type BridgeState = z.infer<typeof bridgeStateSchema>;

const bridgeResponseSchema = z.object({
  success: z.boolean(),
  username: z.string().optional(),
  warning: z.string().optional(),
  error: z.string().optional(),
});

export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;

/** The state file path: `MCP_HOST_BRIDGE_STATE`, else the legacy `MINDSTONE_REBEL_BRIDGE_STATE`. */
export function bridgeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MCP_HOST_BRIDGE_STATE || env.MINDSTONE_REBEL_BRIDGE_STATE || '';
}

/** Whether a bridge state path is configured (not whether the bridge is usable). */
export function isBridgeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return bridgeStatePath(env) !== '';
}

/** Read and validate the bridge state file; `null` (with one stderr line) when it is unusable. */
export function readBridgeState(statePath: string, connector: string): BridgeState | null {
  if (!statePath) return null;
  const result = readHardenedJsonFile(statePath, bridgeStateSchema, MAX_BRIDGE_STATE_BYTES);
  if (!result.ok) {
    console.error(`[${connector}] bridge state rejected: ${result.reason}`);
    return null;
  }
  return result.value;
}

export interface PostToBridgeOptions {
  /** Connector name, for stderr lines and envelope sources. */
  connector: string;
  timeoutMs: number;
  /** Defaults to `bridgeStatePath()`. */
  statePath?: string;
}

/**
 * POST to the host app bridge, a loopback HTTP server inside the host app that
 * handles credential management. Network failures (a refused redirect, a
 * timeout, a refused connection) are thrown for the caller to report.
 */
export async function postToBridge(
  urlPath: string,
  body: Record<string, unknown>,
  options: PostToBridgeOptions,
): Promise<BridgeResponse> {
  const { connector, timeoutMs } = options;
  if (!urlPath.startsWith('/')) {
    // Anything else could change the URL's authority (e.g. `@host`).
    return { success: false, error: 'Bridge request path must start with /' };
  }
  const bridge = readBridgeState(options.statePath ?? bridgeStatePath(), connector);
  if (!bridge) {
    return { success: false, error: 'Bridge not available' };
  }
  const response = await fetch(`http://127.0.0.1:${bridge.port}${urlPath}`, {
    method: 'POST',
    // Never follow a redirect, which would resend the token-bearing body off loopback.
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401 || response.status === 403) {
    // Discarding the body is connection hygiene only, so it is not awaited: a
    // cancel that never settles (msw's mocked bodies do not) must not hold the
    // unauthorized answer, and an errored body stream must not replace it.
    void response.body?.cancel().catch(() => {
      console.error(`[${connector}] bridge reply body could not be discarded`);
    });
    return {
      success: false,
      error: `Bridge returned ${response.status}: unauthorized. Check host app authentication.`,
    };
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
  const { success, username, warning, error } = parsed.data;
  return {
    success,
    ...(username ? { username: wrapUntrusted(username, `${connector}:bridge.username`) } : {}),
    ...(warning ? { warning: wrapUntrusted(warning, `${connector}:bridge.warning`) } : {}),
    ...(error ? { error: wrapUntrusted(error, `${connector}:bridge.error`) } : {}),
  };
}
