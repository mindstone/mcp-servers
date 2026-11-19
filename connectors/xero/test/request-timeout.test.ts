import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XeroClient } from "xero-node";

vi.hoisted(() => {
  process.env.XERO_CLIENT_ID = "test-client-id";
  process.env.XERO_CLIENT_SECRET = "test-client-secret";
});

import { XERO_REQUEST_TIMEOUT_MS } from "../src/auth/token-grant.js";
import { loadSdkAxios } from "../src/clients/sdk-axios.js";
import "../src/clients/xero-client.js";
import { formatError } from "../src/helpers/format-error.js";
import { formatTokenRequestError } from "../src/helpers/format-token-error.js";

const sdkAxios = loadSdkAxios();
const originalAdapter = sdkAxios.defaults.adapter;

afterEach(() => {
  sdkAxios.defaults.adapter = originalAdapter;
});

/** Call one real xero-node API method, its transport replaced by `adapter`. */
async function callSdk(adapter: AxiosAdapter): Promise<unknown> {
  sdkAxios.defaults.adapter = adapter;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const xero = new XeroClient();
    const settled = await Promise.race([
      xero.accountingApi.getOrganisations("tenant").then(
        () => ({ rejected: false as const }),
        (reason: unknown) => ({ rejected: true as const, reason }),
      ),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 1_000)),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    expect(settled).not.toBe("pending");
    expect(settled).toMatchObject({ rejected: true });
    return (settled as { reason: unknown }).reason;
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

function failWith(code: string, seen?: InternalAxiosRequestConfig[]): AxiosAdapter {
  return async (config) => {
    seen?.push(config);
    throw new sdkAxios.AxiosError("socket detail with internals", code, config);
  };
}

describe("Xero request timeout", () => {
  it("bounds this connector's axios and xero-node's own copy", () => {
    expect(axios.defaults.timeout).toBe(XERO_REQUEST_TIMEOUT_MS);
    // xero-node loads axios's CommonJS build: a separate instance.
    expect(sdkAxios).not.toBe(axios);
    expect(sdkAxios.defaults.timeout).toBe(XERO_REQUEST_TIMEOUT_MS);
  });

  it("sends a real xero-node call with the timeout, and settles it when it times out", async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    const reason = await callSdk(failWith("ECONNABORTED", seen));
    expect(seen[0]?.timeout).toBe(XERO_REQUEST_TIMEOUT_MS);
    expect(formatError(reason)).toBe("Xero did not answer in time. Please try again.");
  });

  it("settles a call that could not reach Xero, without quoting the socket error", async () => {
    const reason = await callSdk(failWith("ECONNREFUSED"));
    expect(formatError(reason)).toBe(
      "Could not reach Xero. Please check the connection and try again.",
    );
    expect(JSON.stringify(reason)).not.toContain("internals");
  });

  it("says Xero did not answer in time when a request times out", () => {
    const timedOut = new AxiosError("timeout of 30000ms exceeded", AxiosError.ECONNABORTED);
    expect(formatError(timedOut)).toBe("Xero did not answer in time. Please try again.");
    expect(formatError(new sdkAxios.AxiosError("timeout", "ECONNABORTED"))).toBe(
      "Xero did not answer in time. Please try again.",
    );
    expect(formatTokenRequestError(timedOut)).toBe(
      "Xero authentication failed: Xero did not answer in time. Please try again.",
    );
  });
});
