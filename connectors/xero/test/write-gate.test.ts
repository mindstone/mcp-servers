import { afterEach, describe, expect, it, vi } from "vitest";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withWriteGate, writesAllowed } from "../src/helpers/write-gate.js";

const ENV_VAR = "XERO_ALLOW_WRITES";

describe("XERO_ALLOW_WRITES write gate", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("is closed unless the env var is exactly '1'", () => {
    delete process.env[ENV_VAR];
    expect(writesAllowed()).toBe(false);

    for (const value of ["", "0", "true", "yes", "TRUE", "2"]) {
      process.env[ENV_VAR] = value;
      expect(writesAllowed()).toBe(false);
    }

    process.env[ENV_VAR] = "1";
    expect(writesAllowed()).toBe(true);
  });

  it("blocks the wrapped handler and names the env var when closed", async () => {
    delete process.env[ENV_VAR];
    const handler = vi.fn();
    const gated = withWriteGate({
      name: "create-invoice",
      description: "test",
      schema: {},
      handler,
    });

    const result = (await gated.handler({}, {} as never)) as CallToolResult;

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(text).toContain("XERO_ALLOW_WRITES=1");
    expect(text).toContain("create-invoice");
  });

  it("passes through to the wrapped handler when open", async () => {
    process.env[ENV_VAR] = "1";
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "ok" }],
    });
    const gated = withWriteGate({
      name: "create-invoice",
      description: "test",
      schema: {},
      handler,
    });

    const result = await gated.handler({} as never, {} as never);

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
  });
});
