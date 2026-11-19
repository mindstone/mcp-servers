import { getRequestTimeoutMs } from './types.js';
import { type BridgeResponse, postToBridge } from './bridge-reader.js';

/**
 * Post a credential configuration request to the host app bridge, a loopback
 * HTTP server inside the host app that handles credential management.
 *
 * The host sets MCP_BRIDGE_CONFIGURE_ENDPOINT when it spawns the connector and
 * controls the path format; the connector never hardcodes it. Returns
 * `{ success: false }` when the endpoint or the bridge is not available.
 *
 * `bridge-reader.ts` is the vendored hardened reader: keep it byte-identical to
 * `test-harness/src/bridge-reader.ts` (`scripts/check-bridge-reader.mjs`
 * enforces this) and read the bridge only through it.
 */
export const configureViaBridge = async (
  body: Record<string, unknown>,
): Promise<BridgeResponse> => {
  const endpoint = process.env.MCP_BRIDGE_CONFIGURE_ENDPOINT || '';
  if (!endpoint) {
    return { success: false, error: 'Bridge configure endpoint not set' };
  }
  return postToBridge(endpoint, body, {
    connector: 'browserbase',
    timeoutMs: getRequestTimeoutMs(),
  });
};
