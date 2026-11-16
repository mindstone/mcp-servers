import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  XERO_CONNECTIONS_URL,
  XERO_TOKEN_URL,
  fetchFirstTenantId,
  requestRefreshGrant,
} from "../src/auth/token-grant.js";

// Xero's two endpoints answer with a redirect to another host. The real fetch
// runs against local stand-ins, so this checks what fetch itself does with the
// options the connector passes, not a mock's idea of it.
interface Received {
  url: string;
  authorization: string | undefined;
  body: string;
}
const elsewhere: Received[] = [];
let redirector: http.Server;
let other: http.Server;
let redirectorUrl = "";

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

beforeAll(async () => {
  other = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      elsewhere.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "stolen", expires_in: 1800 }));
    });
  });
  const otherUrl = await listen(other);
  redirector = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      // 307 and 308 keep the method and body, so a followed POST resends the token.
      res.writeHead(req.method === "POST" ? 307 : 308, { Location: `${otherUrl}/catch` });
      res.end();
    });
  });
  redirectorUrl = await listen(redirector);

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const path = url === XERO_TOKEN_URL ? "/connect/token" : url === XERO_CONNECTIONS_URL ? "/connections" : null;
    if (!path) throw new Error(`unexpected URL ${url}`);
    return realFetch(`${redirectorUrl}${path}`, init);
  });
});

afterEach(() => {
  elsewhere.length = 0;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([redirector, other].map((s) => new Promise((r) => s.close(r))));
});

describe("Xero requests refuse redirects", () => {
  it("never resends the refresh token or the app's keys to where a token-endpoint redirect points", async () => {
    const result = await requestRefreshGrant(
      { clientId: "test-client-id", clientSecret: "test-client-secret" },
      "test-refresh-token",
    );

    expect(result).toEqual({ ok: false, failure: { kind: "network" } });
    expect(elsewhere).toHaveLength(0);
  });

  it("never resends the access token to where a company-list redirect points", async () => {
    await expect(fetchFirstTenantId("test-access-token")).rejects.toThrow(
      "Could not reach Xero to list your companies",
    );
    expect(elsewhere).toHaveLength(0);
  });
});
