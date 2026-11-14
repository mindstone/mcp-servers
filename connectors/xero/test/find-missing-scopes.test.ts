import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";

import { XERO_CUSTOM_CONNECTION_SCOPES } from "../src/clients/xero-scopes.js";
import { findMissingScopes } from "../src/helpers/find-missing-scopes.js";
import { formatMissingScopesMessage } from "../src/helpers/format-token-error.js";

function axiosError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError("Request failed", String(status), config as never, null, {
    status,
    data,
    statusText: "",
    headers: {},
    config,
  } as never);
}

const invalidScope = () => axiosError(400, { error: "invalid_scope" });

describe("findMissingScopes", () => {
  it("names exactly the scopes Xero refuses on their own", async () => {
    const refused = new Set(["payroll.timesheets", "accounting.attachments.read"]);
    const asked: string[] = [];
    const missing = await findMissingScopes(async (scope) => {
      asked.push(scope);
      if (refused.has(scope)) throw invalidScope();
      return {};
    });

    expect(asked).toEqual([...XERO_CUSTOM_CONNECTION_SCOPES]);
    expect(missing).toEqual(["accounting.attachments.read", "payroll.timesheets"]);
  });

  it("gives up (null) when a probe fails for another reason", async () => {
    const missing = await findMissingScopes(async () => {
      throw axiosError(429, {});
    });
    expect(missing).toBeNull();
  });
});

describe("formatMissingScopesMessage", () => {
  it("lists only the missing scopes", () => {
    const message = formatMissingScopesMessage(["payroll.timesheets"]);
    expect(message).toContain("missing 1 scope: payroll.timesheets.");
    expect(message).toContain("https://developer.xero.com/app/manage");
    expect(message).toContain("authorised again");
    expect(message).not.toContain("accounting.invoices");
  });

  it("falls back to the full list when none can be singled out", () => {
    const message = formatMissingScopesMessage([]);
    expect(message).toContain("missing required scopes");
    expect(message).toContain("accounting.invoices");
  });
});
