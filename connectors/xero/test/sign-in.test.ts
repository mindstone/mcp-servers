import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  process.env.XERO_CLIENT_ID = "test-client-id";
  process.env.XERO_CLIENT_SECRET = "test-client-secret";
  return {
    mode: "custom-connection" as "bearer" | "refresh-token" | "custom-connection",
    authenticate: vi.fn(),
    client: { authenticate: undefined as unknown, tenantId: "" },
  };
});

vi.mock("../src/clients/xero-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/clients/xero-client.js")>();
  state.client.authenticate = state.authenticate;
  return {
    ...actual,
    get xeroAuthMode() {
      return state.mode;
    },
    xeroClient: state.client,
  };
});

import {
  XeroClientCredentialsRefusedError,
  XeroRefreshError,
} from "../src/clients/xero-client.js";
import { XeroConnectorError } from "../src/helpers/connector-error.js";
import { START_AUTH_PATH, signInToXero } from "../src/tools/sign-in.tool.js";

// The real bridge wrapper and vendored reader talk to this stand-in host.
interface HostRequest {
  url: string;
  authorization: string | undefined;
  body: { scopes?: string[] };
}
const host = {
  requests: [] as HostRequest[],
  reply: { status: 200, body: { success: true } as unknown },
};
let server: http.Server;
let stateDir: string;
let statePath: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      host.requests.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: JSON.parse(raw || "{}"),
      });
      res.writeHead(host.reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(host.reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "xero-sign-in-"));
  statePath = path.join(stateDir, "bridge.json");
  const { port } = server.address() as AddressInfo;
  fs.writeFileSync(statePath, JSON.stringify({ port, token: "bridge-token" }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  state.mode = "custom-connection";
  state.client.tenantId = "";
  state.authenticate.mockReset().mockResolvedValue(undefined);
  host.requests = [];
  host.reply = { status: 200, body: { success: true } };
  process.env.MCP_HOST_BRIDGE_STATE = statePath;
});

function webAppKeys(): void {
  state.authenticate.mockRejectedValue(new XeroClientCredentialsRefusedError("refused"));
}

describe("xero_sign_in", () => {
  it("keeps a working Custom Connection without opening the browser", async () => {
    expect(await signInToXero()).toMatchObject({ ok: true, status: "authenticated" });
    expect(host.requests).toHaveLength(0);
  });

  it("asks Rebel to run Sign in with Xero when the keys belong to a Web app", async () => {
    webAppKeys();

    expect(await signInToXero()).toEqual({
      ok: true,
      status: "authenticated",
      message: "Signed in to Xero.",
    });
    expect(host.requests).toHaveLength(1);
    const [request] = host.requests;
    expect(request.url).toBe(START_AUTH_PATH);
    expect(request.authorization).toBe("Bearer bridge-token");
    expect(request.body.scopes).toContain("offline_access");
    expect(request.body.scopes).toContain("accounting.invoices");
  });

  it("passes on Rebel's reason, enveloped by the bridge reader, when the sign-in does not finish", async () => {
    webAppKeys();
    host.reply = { status: 500, body: { success: false, error: "You closed the Xero page." } };

    const result = await signInToXero();

    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain("You closed the Xero page.");
    expect(error).toContain('<untrusted-content source="xero:bridge.error">');
  });

  it("refuses a reply in the wrong shape", async () => {
    webAppKeys();
    host.reply = { status: 200, body: { ok: "yes" } };

    expect(await signInToXero()).toEqual({
      ok: false,
      error: "Bridge returned an unexpected response shape",
    });
  });

  it("says so when Rebel does not answer in time", async () => {
    webAppKeys();
    const sendTimeout = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      const timeout = new Error("timed out");
      timeout.name = "TimeoutError";
      throw timeout;
    });

    expect(await signInToXero()).toMatchObject({
      ok: false,
      error: expect.stringContaining("5 minutes"),
    });
    sendTimeout.mockRestore();
  });

  it("explains the other ways in when Rebel is not running it", async () => {
    webAppKeys();
    delete process.env.MCP_HOST_BRIDGE_STATE;

    expect(await signInToXero()).toMatchObject({
      ok: false,
      error: expect.stringContaining("XERO_REFRESH_TOKEN"),
    });
    expect(host.requests).toHaveLength(0);
  });

  it("shows a Custom Connection's own setup error, such as missing scopes, without opening the browser", async () => {
    state.authenticate.mockRejectedValue(new XeroConnectorError("missing 1 scope: accounting.invoices"));

    expect(await signInToXero()).toEqual({ ok: false, error: "missing 1 scope: accounting.invoices" });
    expect(host.requests).toHaveLength(0);
  });

  it("replaces an unexpected error's own text with a fixed sentence", async () => {
    state.authenticate.mockRejectedValue(new Error("socket hang up at 10.0.0.5:443"));

    const result = await signInToXero();
    expect(result).toEqual({
      ok: false,
      error: "An unexpected error occurred while communicating with Xero.",
    });
    expect(host.requests).toHaveLength(0);
  });

  it("reports an existing sign-in that still works", async () => {
    state.mode = "refresh-token";
    expect(await signInToXero()).toMatchObject({ ok: true, message: "Already signed in to Xero." });
    expect(host.requests).toHaveLength(0);
  });

  it("signs in again when Xero no longer accepts the saved sign-in", async () => {
    state.mode = "refresh-token";
    state.authenticate.mockRejectedValue(
      new XeroRefreshError({ kind: "http", status: 400, code: "invalid_grant" }),
    );

    expect(await signInToXero()).toMatchObject({ ok: true, status: "authenticated" });
    expect(host.requests).toHaveLength(1);
  });

  it.each([401, 403])("signs in again when Xero refuses the saved sign-in with HTTP %i and no code", async (status) => {
    state.mode = "refresh-token";
    state.authenticate.mockRejectedValue(new XeroRefreshError({ kind: "http", status }));

    expect(await signInToXero()).toMatchObject({ ok: true, status: "authenticated" });
    expect(host.requests).toHaveLength(1);
  });

  it.each(["invalid_client", "unauthorized_client"] as const)(
    "says to check the keys, without opening the browser, when Xero answers %s",
    async (code) => {
      state.mode = "refresh-token";
      state.authenticate.mockRejectedValue(new XeroRefreshError({ kind: "http", status: 400, code }));

      expect(await signInToXero()).toMatchObject({ ok: false, error: expect.stringContaining("Client ID and Client Secret") });
      expect(host.requests).toHaveLength(0);
    },
  );

  it.each([
    [429, "rate limiting", undefined],
    [408, "having trouble", undefined],
    [500, "having trouble", undefined],
    [503, "having trouble", undefined],
    // A contradictory body on an outage still reads as an outage.
    [503, "having trouble", "invalid_grant"],
  ] as const)("does not open the browser when Xero answers HTTP %i, and says to try again", async (status, words, code) => {
    state.mode = "refresh-token";
    state.authenticate.mockRejectedValue(new XeroRefreshError({ kind: "http", status, code }));

    const result = await signInToXero();

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(words) });
    expect(result).toMatchObject({ error: expect.stringContaining("try again") });
    expect(result).not.toMatchObject({ error: expect.stringContaining("sign in again") });
    expect(host.requests).toHaveLength(0);
  });

  it("does not open the browser when Xero is merely unreachable", async () => {
    state.mode = "refresh-token";
    state.authenticate.mockRejectedValue(new XeroRefreshError({ kind: "network" }));

    expect(await signInToXero()).toMatchObject({ ok: false, error: expect.stringContaining("network") });
    expect(host.requests).toHaveLength(0);
  });

  it("checks a bearer token reaches a company", async () => {
    state.mode = "bearer";
    state.authenticate.mockImplementation(async () => {
      state.client.tenantId = "tenant-1";
    });

    expect(await signInToXero()).toMatchObject({ ok: true, status: "authenticated" });
    expect(state.authenticate).toHaveBeenCalledTimes(1);
    expect(host.requests).toHaveLength(0);
  });

  it("reports a refused bearer token without Xero's words and without opening the browser", async () => {
    state.mode = "bearer";
    state.authenticate.mockRejectedValue(new Error("401 secret-echo"));

    const result = await signInToXero();

    expect(result).toEqual({
      ok: false,
      error: "Xero did not accept the token in XERO_CLIENT_BEARER_TOKEN.",
    });
    expect(host.requests).toHaveLength(0);
  });

  it("reports a bearer token that reaches no company", async () => {
    state.mode = "bearer";

    expect(await signInToXero()).toMatchObject({
      ok: false,
      error: expect.stringContaining("no Xero company"),
    });
  });
});
