import { createRedactor, sensitiveValues } from './api-sensitive.js';
import { getApiKey } from './auth.js';
import { unwrapUntrusted } from './untrusted-content.js';
import { REQUEST_TIMEOUT_MS } from './types.js';
import { type BridgeResponse, postToBridge } from './bridge-reader.js';

export type { BridgeResponse };

/** What the vendored reader answers when no usable host app bridge is configured. */
export const BRIDGE_NOT_AVAILABLE = 'Bridge not available';

/**
 * Send a request to the host app bridge, a loopback HTTP server inside the host
 * app that handles credential management. `bridge-reader.ts` is the vendored
 * hardened reader: keep it byte-identical to `test-harness/src/bridge-reader.ts`
 * (`scripts/check-bridge-reader.mjs` enforces this) and read the bridge only
 * through it. Its `error` and `warning` text comes back enveloped as untrusted
 * content; network failures and timeouts are thrown.
 */
export const bridgeRequest = async (
  urlPath: string,
  body: Record<string, unknown>,
): Promise<BridgeResponse> => {
  const redactor = createRedactor([getApiKey(), ...sensitiveValues(body, [])]);
  try {
    const result = await postToBridge(urlPath, body, { connector: 'elevenlabs', timeoutMs: REQUEST_TIMEOUT_MS });
    return { ...result, ...Object.fromEntries(['warning', 'error', 'username'].flatMap(field => {
      const value = result[field as keyof BridgeResponse];
      return typeof value === 'string' ? [[field, value === BRIDGE_NOT_AVAILABLE ? value : redactor.wrap(unwrapUntrusted(value), `elevenlabs:bridge.${field}`)]] : [];
    })) };
  } catch (error) {
    throw new Error(redactor.wrap(error instanceof Error ? error.message : String(error), 'elevenlabs:bridge.error'));
  }
};
