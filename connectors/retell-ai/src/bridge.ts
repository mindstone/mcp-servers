import { REQUEST_TIMEOUT_MS } from './types.js';
import { type BridgeResponse, postToBridge } from './bridge-reader.js';

/**
 * Bridge configure endpoint, set by the host app when spawning the connector.
 * The host controls the path format — the connector never hardcodes it. When it
 * is unset there is no host to save keys to, so keys last for this session only.
 */
export const getBridgeConfigureEndpoint = (): string =>
  process.env.MCP_BRIDGE_CONFIGURE_ENDPOINT || '';

/**
 * Ask the host app bridge, a loopback HTTP server inside the host app that
 * handles credential management, to save a credential configuration.
 * `bridge-reader.ts` is the vendored hardened reader: keep it byte-identical to
 * `test-harness/src/bridge-reader.ts` (`scripts/check-bridge-reader.mjs`
 * enforces this) and read the bridge only through it. Network failures are
 * thrown for the caller to report.
 */
export const saveToBridge = (
  endpoint: string,
  body: Record<string, unknown>,
): Promise<BridgeResponse> =>
  postToBridge(endpoint, body, { connector: 'retell-ai', timeoutMs: REQUEST_TIMEOUT_MS });
