import { beforeEach, describe, expect, it, vi } from "vitest";

const { post, get } = vi.hoisted(() => {
  process.env.XERO_CLIENT_ID = "test-client-id";
  process.env.XERO_CLIENT_SECRET = "test-client-secret";
  return { post: vi.fn(), get: vi.fn() };
});

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return { ...actual, default: { ...actual.default, post, get } };
});

import {
  CustomConnectionsXeroClient,
  XeroClientCredentialsRefusedError,
} from "../src/clients/xero-client.js";

/** Just enough of an axios error for axios.isAxiosError and the token-error formatter. */
function oauthError(status: number, code: string) {
  return Object.assign(new Error("failed"), {
    isAxiosError: true,
    response: { status, data: { error: code } },
  });
}

const client = () =>
  new CustomConnectionsXeroClient({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    grantType: "client_credentials",
  });

beforeEach(() => {
  post.mockReset();
  get.mockReset();
});

describe("Custom Connection requests", () => {
  it("never follow a redirect with the app's keys or the access token", async () => {
    post.mockResolvedValue({ data: { access_token: "test-access", expires_in: 1800 } });
    get.mockResolvedValue({ data: [{ tenantId: "tenant-1" }] });

    await client().authenticate();

    expect(post).toHaveBeenCalledWith(
      "https://identity.xero.com/connect/token",
      expect.any(String),
      expect.objectContaining({ maxRedirects: 0 }),
    );
    expect(get).toHaveBeenCalledWith(
      "https://api.xero.com/connections",
      expect.objectContaining({ maxRedirects: 0 }),
    );
  });
});

describe("Custom Connection grant refused", () => {
  it.each(["unauthorized_client", "invalid_client"])(
    "marks %s as keys that need Sign in with Xero",
    async (code) => {
      post.mockImplementation(async () => {
        throw oauthError(400, code);
      });
      const error = await client()
        .authenticate()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(XeroClientCredentialsRefusedError);
    },
  );

  it("keeps other failures as plain errors", async () => {
    post.mockImplementation(async () => {
      throw oauthError(429, "rate_limited");
    });
    const error = await client().authenticate().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(XeroClientCredentialsRefusedError);
    expect((error as Error).message).toMatch(/rate limited/);
  });
});
