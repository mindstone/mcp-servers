import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";
import { formatError } from "../src/helpers/format-error.js";

function makeAxiosError(status: number, detail?: string): AxiosError {
  const headers = new AxiosHeaders();
  const config = { headers };
  return new AxiosError(
    "Request failed",
    String(status),
    config as never,
    null,
    {
      status,
      data: detail ? { Detail: detail } : {},
      statusText: "",
      headers: {},
      config,
    } as never,
  );
}

describe("formatError", () => {
  it("maps common Axios statuses to user-facing messages", () => {
    expect(formatError(makeAxiosError(401))).toBe(
      "Authentication failed. Please check your Xero credentials.",
    );
    expect(formatError(makeAxiosError(403))).toBe(
      "You don't have permission to access this resource in Xero.",
    );
    expect(formatError(makeAxiosError(404))).toBe(
      "The requested resource was not found in Xero.",
    );
    expect(formatError(makeAxiosError(429))).toBe(
      "Too many requests to Xero. Please try again in a moment.",
    );
  });

  it("extracts SDK problem details without leaking request headers", () => {
    const sdkError = {
      response: {
        statusCode: 405,
        body: {
          httpStatusCode: "MethodNotAllowed",
          problem: {
            title: "MethodNotAllowed",
            detail: "Method not allowed for the current customer jurisdiction.",
            status: 405,
          },
        },
        headers: { "set-cookie": "ak_bmsc=secret" },
      },
      request: {
        headers: { authorization: "Bearer eyJSECRET" },
      },
    };

    const result = formatError(sdkError);

    expect(result).toBe(
      "405 MethodNotAllowed: Method not allowed for the current customer jurisdiction.",
    );
    expect(result).not.toContain("Bearer");
    expect(result).not.toContain("eyJSECRET");
    expect(result).not.toContain("set-cookie");
  });

  it("extracts SDK validation errors without leaking request headers", () => {
    const sdkError = {
      response: {
        status: 400,
        body: {
          Type: "ValidationException",
          Message: "A validation exception occurred",
          Elements: [
            {
              ValidationErrors: [
                {
                  Message:
                    "Currency GBP is not enabled for this organisation.",
                },
              ],
            },
          ],
        },
        headers: { "set-cookie": "ak_bmsc=secret" },
      },
      request: {
        headers: { authorization: "Bearer eyJSECRET" },
      },
    };

    const result = formatError(sdkError);

    expect(result).toBe(
      "400 ValidationException: Currency GBP is not enabled for this organisation.",
    );
    expect(result).not.toContain("Bearer");
    expect(result).not.toContain("eyJSECRET");
    expect(result).not.toContain("set-cookie");
  });

  it("extracts stringified SDK validation errors without leaking request headers", () => {
    const sdkError = JSON.stringify({
      response: {
        statusCode: 400,
        body: {
          Type: "ValidationException",
          Message: "A validation exception occurred",
          Elements: [
            {
              ValidationErrors: [
                {
                  Message:
                    "Currency GBP is not enabled for this organisation.",
                },
              ],
            },
          ],
        },
        headers: { "set-cookie": "ak_bmsc=secret" },
        request: {
          headers: { authorization: "Bearer eyJSECRET" },
        },
      },
      body: {
        Type: "ValidationException",
      },
    });

    const result = formatError(sdkError);

    expect(result).toBe(
      "400 ValidationException: Currency GBP is not enabled for this organisation.",
    );
    expect(result).not.toContain("Bearer");
    expect(result).not.toContain("eyJSECRET");
    expect(result).not.toContain("set-cookie");
  });

  it("does not stringify unknown error objects", () => {
    const leakyUnknown = {
      request: { headers: { authorization: "Bearer LEAKY_TOKEN" } },
    };

    const result = formatError(leakyUnknown);

    expect(result).toBe(
      "An unexpected error occurred while communicating with Xero.",
    );
    expect(result).not.toContain("Bearer");
    expect(result).not.toContain("LEAKY_TOKEN");
  });
});
