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
 * bridge bearer token and its `port` is put into the request URL:
 *
 * - An `lstat` refusal of a symlinked final component, then `O_NOFOLLOW` on the
 *   open where the platform defines it. Symlinked ancestors stay allowed (host
 *   state dirs can resolve through e.g. /var -> /private/var).
 * - `O_NONBLOCK`, so a FIFO at the path is opened and refused instead of
 *   blocking the process waiting for a writer.
 * - Same-descriptor fstat (regular file) and a read through that descriptor of
 *   at most 64 KiB (a larger or growing file is refused), plus a realpath inode
 *   cross-check that refuses the read when the path no
 *   longer names the opened file. Where `O_NOFOLLOW` is unavailable (Windows)
 *   this narrows, but cannot rule out, a symlink swap raced between lstat and
 *   open.
 * - Strict schema validation of the content. The token must be visible ASCII,
 *   so it can never make the `Authorization` header invalid: fetch would quote
 *   the whole header value in its error.
 *
 * Any local process able to bind the port can answer a request, and would
 * receive the token and the request body; nothing here can detect that, so it
 * rests on the host app owning the port. The reply is therefore schema-checked,
 * never cast, and its free text is enveloped before it can reach the model. Each refusal logs one fixed stderr line; file content and
 * error messages (which can quote the path) are never logged.
 */
import * as fs from 'fs';
import { z } from 'zod';
import { wrapUntrusted } from './untrusted-content.js';

export const MAX_BRIDGE_STATE_BYTES = 64 * 1024;

const bridgeStateSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[\x21-\x7e]+$/),
});

export type BridgeState = z.infer<typeof bridgeStateSchema>;

const bridgeResponseSchema = z.object({
  success: z.boolean(),
  warning: z.string().optional(),
  error: z.string().optional(),
});

export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;

/** The state file path: `MCP_HOST_BRIDGE_STATE`, else the legacy `MINDSTONE_REBEL_BRIDGE_STATE`. */
export function bridgeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MCP_HOST_BRIDGE_STATE || env.MINDSTONE_REBEL_BRIDGE_STATE || '';
}

function refuse(connector: string, reason: string): null {
  console.error(`[${connector}] bridge state rejected: ${reason}`);
  return null;
}

/** Read and validate the bridge state file; `null` (with one stderr line) when it is unusable. */
export function readBridgeState(statePath: string, connector: string): BridgeState | null {
  if (!statePath) return null;
  let fd: number | null = null;
  try {
    if (fs.lstatSync(statePath).isSymbolicLink()) {
      return refuse(connector, 'state path is a symbolic link');
    }
    fd = fs.openSync(
      statePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      return refuse(connector, 'not a regular file');
    }
    const canonical = fs.statSync(fs.realpathSync(statePath));
    if (canonical.dev !== opened.dev || canonical.ino !== opened.ino) {
      return refuse(connector, 'path resolved to a different file than was opened');
    }
    const buffer = Buffer.alloc(MAX_BRIDGE_STATE_BYTES + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > MAX_BRIDGE_STATE_BYTES) {
      return refuse(connector, 'state file is too large');
    }
    const raw = buffer.toString('utf8', 0, length);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return refuse(connector, 'malformed JSON');
    }
    const parsed = bridgeStateSchema.safeParse(json);
    if (!parsed.success) {
      return refuse(connector, 'content failed schema validation');
    }
    return parsed.data;
  } catch {
    // Missing, unreadable, or a symlink refused by O_NOFOLLOW (ELOOP).
    return refuse(connector, 'state file could not be read');
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // A close failure on a read-only descriptor changes nothing.
      }
    }
  }
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
    // Discarding the body is connection hygiene only: an errored body stream
    // must not replace the unauthorized answer.
    await response.body?.cancel().catch(() => {
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
  return {
    success: parsed.data.success,
    ...(parsed.data.warning !== undefined
      ? { warning: wrapUntrusted(parsed.data.warning, `${connector}:bridge.warning`) }
      : {}),
    ...(parsed.data.error !== undefined
      ? { error: wrapUntrusted(parsed.data.error, `${connector}:bridge.error`) }
      : {}),
  };
}
