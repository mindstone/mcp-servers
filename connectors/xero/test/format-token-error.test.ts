import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";
import { formatTokenRequestError } from "../src/helpers/format-token-error.js";

function makeAxiosError(status: number, data: unknown): AxiosError {
  const config = {
    headers: new AxiosHeaders({
      Authorization: "Basic client-secret-value",
    }),
  };

  return new AxiosError(
    "Request failed",
    String(status),
    config as never,
    null,
    {
      status,
      data,
      statusText: "",
      headers: {},
      config,
    } as never,
  );
}

describe("formatTokenRequestError", () => {
  it("returns the scoped setup guidance for invalid_scope without leaking request headers", () => {
    const result = formatTokenRequestError(
      makeAxiosError(400, {
        error: "invalid_scope",
        error_description: "scope failed for client-secret-value",
      }),
    );

    expect(result).toContain("missing required scopes");
    expect(result).not.toContain("client-secret-value");
    expect(result).not.toContain("error_description");
  });

  it("maps credential failures without echoing provider payloads", () => {
    const result = formatTokenRequestError(
      makeAxiosError(401, {
        error: "invalid_client",
        error_description: "bad secret client-secret-value",
      }),
    );

    expect(result).toBe(
      "Xero authentication failed. Please check your Xero client ID and client secret.",
    );
    expect(result).not.toContain("client-secret-value");
    expect(result).not.toContain("invalid_client");
  });

  it("uses a generic status message for unexpected provider payloads", () => {
    const result = formatTokenRequestError(
      makeAxiosError(500, {
        access_token: "xero-access-token-value",
      }),
    );

    expect(result).toBe(
      "Xero authentication failed with HTTP 500. Please check your Xero connection details.",
    );
    expect(result).not.toContain("xero-access-token-value");
  });
});
