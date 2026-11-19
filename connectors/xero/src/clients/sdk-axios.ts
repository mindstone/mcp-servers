import { createRequire } from "node:module";

import type { AxiosError, AxiosStatic } from "axios";

import { XERO_REQUEST_TIMEOUT_MS } from "../auth/token-grant.js";

/**
 * The axios that xero-node itself calls. xero-node is CommonJS and loads
 * axios's CommonJS build, while this connector imports the ES module build:
 * two separate instances, so a default set on ours never reaches the SDK.
 */
export function loadSdkAxios(): AxiosStatic {
  const requireHere = createRequire(import.meta.url);
  const requireFromSdk = createRequire(requireHere.resolve("xero-node"));
  const loaded = requireFromSdk("axios") as AxiosStatic & { default?: AxiosStatic };
  return loaded.default ?? loaded;
}

/** What a request that got no answer from Xero becomes, by kind. */
export type XeroTransportFailureKind = "timeout" | "network";

/**
 * The stand-in a response-less failure is rejected with. xero-node turns every
 * failed call into an ApiError, whose constructor reads `error.response.status`
 * and `error.request.getHeaders()`: on a timeout there is no response, the
 * constructor throws inside the SDK's promise, and the call never settles. This
 * shape lets it settle, and carries no request headers (they hold the token).
 */
export interface XeroTransportFailure {
  response: { status: 0; data: { XeroConnectorTransportFailure: XeroTransportFailureKind }; headers: Record<string, never> };
  request: { getHeaders: () => Record<string, never> };
}

export function toTransportFailure(error: AxiosError): XeroTransportFailure {
  const kind: XeroTransportFailureKind =
    error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" ? "timeout" : "network";
  return {
    response: { status: 0, data: { XeroConnectorTransportFailure: kind }, headers: {} },
    request: { getHeaders: () => ({}) },
  };
}

/** Bound the SDK's requests and make its response-less failures settle safely. */
export function configureSdkAxios(sdkAxios: AxiosStatic): void {
  sdkAxios.defaults.timeout = XERO_REQUEST_TIMEOUT_MS;
  sdkAxios.interceptors.response.use(undefined, (error: unknown) => {
    if (sdkAxios.isAxiosError(error) && !error.response) {
      return Promise.reject(toTransportFailure(error));
    }
    return Promise.reject(error);
  });
}
