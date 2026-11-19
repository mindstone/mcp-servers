import { REQUEST_TIMEOUT_MS } from './types.js';
import { type BridgeResponse, postToBridge } from './bridge-reader.js';

/**
 * Send a request to the host app bridge, a loopback HTTP server inside the host
 * app that handles credential management. `bridge-reader.ts` is the vendored
 * hardened reader: keep it byte-identical to `test-harness/src/bridge-reader.ts`
 * (`scripts/check-bridge-reader.mjs` enforces this) and read the bridge only
 * through it. Its `username`, `warning` and `error` come back already enveloped.
 *
 * `timeoutMs` defaults to the ordinary per-call budget (REQUEST_TIMEOUT_MS);
 * callers that trigger long host-side flows (e.g. interactive OAuth) can opt
 * into a longer one. The abort itself is never removed — only widened — so a
 * dead bridge still fails within the chosen bound.
 */
export const bridgeRequest = (
  urlPath: string,
  body: Record<string, unknown> = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<BridgeResponse> => postToBridge(urlPath, body, { connector: 'salesforce', timeoutMs });
