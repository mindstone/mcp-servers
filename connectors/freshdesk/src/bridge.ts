import { REQUEST_TIMEOUT_MS } from './types.js';
import { type BridgeResponse, isBridgeConfigured, postToBridge } from './bridge-reader.js';

export type { BridgeResponse };
export { isBridgeConfigured };

/**
 * Send a request to the host app bridge, a loopback HTTP server inside the host
 * app that handles credential management. `bridge-reader.ts` is the vendored
 * hardened reader: keep it byte-identical to `test-harness/src/bridge-reader.ts`
 * (`scripts/check-bridge-reader.mjs` enforces this) and read the bridge only
 * through it. Its `error` and `warning` text comes back wrapped in an
 * untrusted-content envelope; network failures and timeouts are thrown.
 */
export const bridgeRequest = (
  urlPath: string,
  body: Record<string, unknown>,
): Promise<BridgeResponse> =>
  postToBridge(urlPath, body, { connector: 'freshdesk', timeoutMs: REQUEST_TIMEOUT_MS });
