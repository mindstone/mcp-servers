import { REQUEST_TIMEOUT_MS } from './types.js';
import { type BridgeResponse, postToBridge } from './bridge-reader.js';

export type { BridgeResponse };

/**
 * The vendored reader's own answer when no host app runs this connector. It
 * gives the same answer when a host-supplied state file is refused (and logs
 * one stderr line), so the two cannot be told apart here. Host-sent error text
 * is always enveloped, so it never equals this.
 */
export const BRIDGE_NOT_AVAILABLE = 'Bridge not available';

/**
 * POST to the host app bridge, a loopback HTTP server inside the host app that
 * saves the account's credentials. `bridge-reader.ts` is the vendored hardened
 * reader: keep it byte-identical to `test-harness/src/bridge-reader.ts`
 * (`scripts/check-bridge-reader.mjs` enforces this) and read the bridge only
 * through it. Its `error` and `warning` text from the host comes back already
 * enveloped; network failures and timeouts are thrown.
 */
export const bridgeRequest = (
  urlPath: string,
  body: Record<string, unknown>,
): Promise<BridgeResponse> =>
  postToBridge(urlPath, body, { connector: 'email-imap', timeoutMs: REQUEST_TIMEOUT_MS });
