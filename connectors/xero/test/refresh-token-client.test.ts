import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeRequest } = vi.hoisted(() => {
  process.env.XERO_CLIENT_ID = "test-client-id";
  process.env.XERO_CLIENT_SECRET = "test-client-secret";
  return { bridgeRequest: vi.fn() };
});

vi.mock("../src/auth/bridge.js", () => ({
  bridgeRequest,
  BRIDGE_SIGN_IN_TIMEOUT_MS: 300_000,
}));

import {
  RefreshTokenXeroClient,
  UPDATE_REFRESH_TOKEN_PATH,
  XeroRefreshError,
} from "../src/clients/xero-client.js";
import { XERO_CONNECTIONS_URL, XERO_TOKEN_URL } from "../src/auth/token-grant.js";

const keys = { clientId: "test-client-id", clientSecret: "test-client-secret" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function tokenCalls(): Array<[string, RequestInit]> {
  return fetchMock.mock.calls.filter(([url]) => url === XERO_TOKEN_URL) as Array<
    [string, RequestInit]
  >;
}

function grantedToken(refreshToken: string, accessToken = "access-1") {
  return json(200, {
    access_token: accessToken,
    expires_in: 1800,
    token_type: "Bearer",
    refresh_token: refreshToken,
  });
}

beforeEach(() => {
  bridgeRequest.mockReset().mockResolvedValue({ success: true });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RefreshTokenXeroClient", () => {
  it("refreshes with the saved token, finds the company and saves the rotated token", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === XERO_TOKEN_URL
        ? grantedToken("refresh-2")
        : json(200, [{ tenantId: "tenant-1" }]),
    );
    const client = new RefreshTokenXeroClient(keys, "refresh-1");

    await client.authenticate();

    const [[, init]] = tokenCalls();
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-1");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from("test-client-id:test-client-secret").toString("base64"),
    );
    expect(fetchMock).toHaveBeenCalledWith(XERO_CONNECTIONS_URL, expect.anything());
    expect(client.tenantId).toBe("tenant-1");
    expect(bridgeRequest).toHaveBeenCalledWith(UPDATE_REFRESH_TOKEN_PATH, {
      refreshToken: "refresh-2",
    });
  });

  it("reuses the access token until five minutes before it expires, then refreshes with the rotated token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let n = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url !== XERO_TOKEN_URL) return json(200, [{ tenantId: "tenant-1" }]);
      n += 1;
      return grantedToken(`refresh-${n + 1}`, `access-${n}`);
    });
    const client = new RefreshTokenXeroClient(keys, "refresh-1");

    await client.authenticate();
    vi.advanceTimersByTime(24 * 60 * 1000);
    await client.authenticate();
    expect(tokenCalls()).toHaveLength(1);

    vi.advanceTimersByTime(2 * 60 * 1000);
    await client.authenticate();
    expect(tokenCalls()).toHaveLength(2);
    const second = new URLSearchParams(String(tokenCalls()[1][1].body));
    expect(second.get("refresh_token")).toBe("refresh-2");
    expect(fetchMock.mock.calls.filter(([url]) => url === XERO_CONNECTIONS_URL)).toHaveLength(1);
  });

  it("runs one refresh at a time, so concurrent calls never spend the same refresh token twice", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(async (url: string) =>
      url === XERO_TOKEN_URL
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : json(200, [{ tenantId: "tenant-1" }]),
    );
    const client = new RefreshTokenXeroClient(keys, "refresh-1");

    const calls = [client.authenticate(), client.authenticate(), client.authenticate()];
    await vi.waitFor(() => expect(tokenCalls()).toHaveLength(1));
    release(grantedToken("refresh-2"));
    await Promise.all(calls);

    expect(tokenCalls()).toHaveLength(1);
  });

  it("does not save the refresh token when Xero hands back the same one", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === XERO_TOKEN_URL
        ? grantedToken("refresh-1")
        : json(200, [{ tenantId: "tenant-1" }]),
    );
    await new RefreshTokenXeroClient(keys, "refresh-1").authenticate();
    expect(bridgeRequest).not.toHaveBeenCalled();
  });

  it("says to sign in again on invalid_grant, without repeating Xero's own words", async () => {
    fetchMock.mockResolvedValue(
      json(400, { error: "invalid_grant", error_description: "token refresh-1 secret-echo" }),
    );
    const client = new RefreshTokenXeroClient(keys, "refresh-1");

    const error = await client.authenticate().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(XeroRefreshError);
    expect((error as XeroRefreshError).failure).toEqual({
      kind: "http",
      status: 400,
      code: "invalid_grant",
    });
    expect((error as Error).message).toContain("sign in again");
    expect((error as Error).message).not.toContain("secret-echo");
    expect((error as Error).message).not.toContain("refresh-1");
  });

  it("allows a retry after a failed refresh", async () => {
    fetchMock.mockResolvedValueOnce(json(503, {}));
    const client = new RefreshTokenXeroClient(keys, "refresh-1");
    await expect(client.authenticate()).rejects.toBeInstanceOf(XeroRefreshError);

    fetchMock.mockImplementation(async (url: string) =>
      url === XERO_TOKEN_URL
        ? grantedToken("refresh-2")
        : json(200, [{ tenantId: "tenant-1" }]),
    );
    await client.authenticate();
    expect(client.tenantId).toBe("tenant-1");
  });

  it("treats a token reply without an access token as malformed", async () => {
    fetchMock.mockResolvedValue(json(200, { expires_in: 1800 }));
    const error = await new RefreshTokenXeroClient(keys, "refresh-1")
      .authenticate()
      .catch((e: unknown) => e);
    expect((error as XeroRefreshError).failure).toEqual({ kind: "malformed", status: 200 });
  });

  it("says to pick a company when the sign-in reaches none", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === XERO_TOKEN_URL ? grantedToken("refresh-2") : json(200, []),
    );
    await expect(new RefreshTokenXeroClient(keys, "refresh-1").authenticate()).rejects.toThrow(
      /pick a company/,
    );
  });

  it("does not report success until a company is found, and looks again without spending the refresh token", async () => {
    let connectionsStatus = 503;
    fetchMock.mockImplementation(async (url: string) =>
      url === XERO_TOKEN_URL
        ? grantedToken("refresh-2")
        : connectionsStatus === 200
          ? json(200, [{ tenantId: "tenant-1" }])
          : json(connectionsStatus, {}),
    );
    const client = new RefreshTokenXeroClient(keys, "refresh-1");

    await expect(client.authenticate()).rejects.toThrow(/HTTP 503/);
    await expect(client.authenticate()).rejects.toThrow(/HTTP 503/);
    expect(client.tenantId).toBe("");

    connectionsStatus = 200;
    await client.authenticate();

    expect(client.tenantId).toBe("tenant-1");
    expect(tokenCalls()).toHaveLength(1);
    expect(bridgeRequest).toHaveBeenCalledTimes(1);
  });

  it("makes a caller that arrives during the company lookup wait for it", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(async (url: string) =>
      url === XERO_TOKEN_URL
        ? grantedToken("refresh-2")
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    );
    const client = new RefreshTokenXeroClient(keys, "refresh-1");

    const first = client.authenticate();
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(XERO_CONNECTIONS_URL, expect.anything()),
    );
    let secondDone = false;
    const second = client.authenticate().then(() => {
      secondDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondDone).toBe(false);

    release(json(200, [{ tenantId: "tenant-1" }]));
    await Promise.all([first, second]);
    expect(client.tenantId).toBe("tenant-1");
  });

  it("never repeats an unreadable company list, which could echo the token", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === XERO_TOKEN_URL
        ? grantedToken("refresh-2", "leak-token")
        : new Response("leak-token", { status: 200 }),
    );
    const error = await new RefreshTokenXeroClient(keys, "refresh-1")
      .authenticate()
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/unreadable/);
    expect((error as Error).message).not.toContain("leak-token");
  });

  it("refuses a company list in the wrong shape without repeating it", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === XERO_TOKEN_URL
        ? grantedToken("refresh-2")
        : json(200, [{ tenantId: 42, note: "leak-token" }]),
    );
    const error = await new RefreshTokenXeroClient(keys, "refresh-1")
      .authenticate()
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/unexpected shape/);
    expect((error as Error).message).not.toContain("leak-token");
  });

  it("picks an organisation over other kinds of Xero tenant", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === XERO_TOKEN_URL
        ? grantedToken("refresh-2")
        : json(200, [
            { tenantId: "practice-1", tenantType: "PRACTICEMANAGER" },
            { tenantId: "org-1", tenantType: "ORGANISATION" },
          ]),
    );
    const client = new RefreshTokenXeroClient(keys, "refresh-1");
    await client.authenticate();
    expect(client.tenantId).toBe("org-1");
  });
});
