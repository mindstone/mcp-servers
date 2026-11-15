import { afterEach, describe, expect, it, vi } from "vitest";

async function modeWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const key of [
    "XERO_CLIENT_ID",
    "XERO_CLIENT_SECRET",
    "XERO_CLIENT_BEARER_TOKEN",
    "XERO_REFRESH_TOKEN",
  ]) {
    vi.stubEnv(key, env[key] ?? "");
  }
  const mod = await import("../src/clients/xero-client.js");
  return { mode: mod.xeroAuthMode, client: mod.xeroClient };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("xeroAuthMode", () => {
  const keys = { XERO_CLIENT_ID: "id", XERO_CLIENT_SECRET: "secret" };

  it("uses a bearer token first", async () => {
    expect(
      (await modeWith({ ...keys, XERO_REFRESH_TOKEN: "r", XERO_CLIENT_BEARER_TOKEN: "b" })).mode,
    ).toBe("bearer");
  });

  it("uses the saved sign-in when there is a refresh token", async () => {
    const { mode, client } = await modeWith({ ...keys, XERO_REFRESH_TOKEN: "r" });
    expect(mode).toBe("refresh-token");
    expect(client.constructor.name).toBe("RefreshTokenXeroClient");
  });

  it("falls back to a Custom Connection when nobody has signed in yet", async () => {
    expect((await modeWith(keys)).mode).toBe("custom-connection");
  });
});

describe("bearer tenant lookup", () => {
  it("forgets a company the token no longer reaches", async () => {
    const { XeroClient } = await import("xero-node");
    const { client } = await modeWith({ XERO_CLIENT_BEARER_TOKEN: "b" });
    const lists = [[{ tenantId: "tenant-1" }], []];
    let current: unknown[] = [];
    const lookup = vi
      .spyOn(XeroClient.prototype, "updateTenants")
      .mockImplementation(async () => {
        current = lists.shift() ?? [];
        return current;
      });
    const tenants = vi
      .spyOn(XeroClient.prototype, "tenants", "get")
      .mockImplementation(() => current as never);

    await client.authenticate();
    expect(client.tenantId).toBe("tenant-1");
    await client.authenticate();
    expect(client.tenantId).toBe("");
    lookup.mockRestore();
    tenants.mockRestore();
  });
});
