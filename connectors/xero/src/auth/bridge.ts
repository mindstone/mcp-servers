import { type BridgeResponse, postToBridge } from "../bridge-reader.js";

export type { BridgeResponse };

/** Ordinary per-call budget for a bridge request. */
export const BRIDGE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Budget for a bridge call that waits while the person signs in to Xero in
 * their browser. Matches the host's own 5-minute sign-in wait.
 */
export const BRIDGE_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** What the vendored reader answers when no host app runs this connector. */
export const BRIDGE_NOT_AVAILABLE = "Bridge not available";

/**
 * POST to the host app bridge through the vendored hardened reader
 * (`../bridge-reader.ts`, kept byte-identical to the test-harness copy).
 * Its `error` and `warning` text comes back wrapped in an untrusted-content
 * envelope; network failures and timeouts are thrown.
 */
export const bridgeRequest = (
  urlPath: string,
  body: Record<string, unknown>,
  timeoutMs: number = BRIDGE_REQUEST_TIMEOUT_MS,
): Promise<BridgeResponse> =>
  postToBridge(urlPath, body, { connector: "xero", timeoutMs });
