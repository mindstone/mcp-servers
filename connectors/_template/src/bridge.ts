import { getRequestTimeoutMs } from './types.js';
import { type BridgeResponse, postToBridge } from './bridge-reader.js';

/**
 * Send a request to the host app bridge, a loopback HTTP server inside the host
 * app that handles credential management. `bridge-reader.ts` is the vendored
 * hardened reader: keep it byte-identical to `test-harness/src/bridge-reader.ts`
 * (`scripts/check-bridge-reader.mjs` enforces this) and read the bridge only
 * through it.
 */
export const bridgeRequest = (
  urlPath: string,
  body: Record<string, unknown>,
): Promise<BridgeResponse> =>
  postToBridge(urlPath, body, { connector: 'CONNECTOR_NAME', timeoutMs: getRequestTimeoutMs() });
