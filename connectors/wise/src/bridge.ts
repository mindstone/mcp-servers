import * as fs from 'fs';
import { z } from 'zod';
import { errorKind } from './client.js';
import { type BridgeState, getRequestTimeoutMs } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

/**
 * Path to bridge state file, supporting both current and legacy env vars.
 *
 * The host sets this path when it spawns the server; the model cannot
 * influence it. The read is still hardened, because the file carries the
 * bridge bearer token and its `port` is interpolated into the request URL:
 *
 * - An `lstat` refusal of a symlinked final component, then `O_NOFOLLOW` on
 *   the open where the platform defines it. Symlinked ancestors stay allowed
 *   (host state dirs can resolve through e.g. /var -> /private/var).
 * - `O_NONBLOCK`, so a FIFO at the path is opened and refused instead of
 *   blocking the process waiting for a writer.
 * - Same-descriptor fstat (regular file, at most 64 KiB) and read-through-fd,
 *   plus a realpath inode cross-check that refuses the read when the path no
 *   longer names the opened file. Where `O_NOFOLLOW` is unavailable this
 *   narrows, but cannot rule out, a symlink swap raced between lstat and open.
 * - Strict schema validation of the content.
 *
 * Each refusal logs one fixed stderr line; file content is never logged.
 */
export const BRIDGE_STATE_PATH =
  process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE || '';

const MAX_BRIDGE_STATE_BYTES = 64 * 1024;

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
 * Any local process able to bind the port can answer, so the bridge reply is
 * validated, and its free text is enveloped before it can reach the model.
 */
const bridgeResponseSchema = z.object({
  success: z.boolean(),
  warning: z.string().optional(),
  error: z.string().optional(),
});

function rejectState(reason: string): null {
  console.error(`[wise] bridge state rejected: ${reason}`);
  return null;
}

const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;
  let fd: number | null = null;
  try {
    if (fs.lstatSync(BRIDGE_STATE_PATH).isSymbolicLink()) {
      return rejectState('state path is a symbolic link');
    }
    fd = fs.openSync(
      BRIDGE_STATE_PATH,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      return rejectState('not a regular file');
    }
    if (opened.size > MAX_BRIDGE_STATE_BYTES) {
      return rejectState('state file is too large');
    }
    const canonical = fs.statSync(fs.realpathSync(BRIDGE_STATE_PATH));
    if (canonical.dev !== opened.dev || canonical.ino !== opened.ino) {
      return rejectState('path resolved to a different file than was opened');
    }
    const raw = fs.readFileSync(fd, 'utf8');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return rejectState('malformed JSON');
    }
    const parsed = bridgeStateSchema.safeParse(json);
    if (!parsed.success) {
      return rejectState('content failed schema validation');
    }
    return parsed.data;
  } catch {
    // Missing, unreadable, or a symlink refused by O_NOFOLLOW (ELOOP). The
    // error text can quote the path, so only a fixed line is logged.
    return rejectState('state file could not be read');
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // A close failure on a read-only descriptor changes nothing.
      }
    }
  }
};

/**
 * Send a request to the host app bridge, a loopback HTTP server inside the
 * host app that handles credential management. Network failures (including a
 * refused redirect or a timeout) are thrown for the caller to report.
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
    // Never follow a redirect, which would resend the token-bearing body off loopback.
    redirect: 'error',
    signal: AbortSignal.timeout(getRequestTimeoutMs()),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401 || response.status === 403) {
    // Discarding the body is connection hygiene only: an errored body stream
    // must not replace the unauthorized answer.
    await response.body?.cancel().catch((error: unknown) => {
      console.error(`[wise] bridge reply body could not be discarded (${errorKind(error)})`);
    });
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
  return {
    success: parsed.data.success,
    ...(parsed.data.warning !== undefined
      ? { warning: wrapUntrusted(parsed.data.warning, 'wise:bridge.warning') }
      : {}),
    ...(parsed.data.error !== undefined
      ? { error: wrapUntrusted(parsed.data.error, 'wise:bridge.error') }
      : {}),
  };
};
