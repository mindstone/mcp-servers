import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";

const connectorRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.XERO_CLIENT_ID = "test-client-id";
  env.XERO_CLIENT_SECRET = "test-client-secret";
  return env;
}

describe("Xero MCP server smoke", () => {
  beforeAll(() => {
    execFileSync(npmCommand(), ["run", "build"], {
      cwd: connectorRoot,
      stdio: "pipe",
    });
  }, 30_000);

  it("starts over stdio and exposes the expected Rebel fork tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(connectorRoot, "dist/index.js")],
      cwd: connectorRoot,
      env: childEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "xero-smoke-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const result = await client.listTools();
      const tools = result.tools;
      const names = tools.map((tool) => tool.name);

      expect(names).toContain("create-invoice");
      expect(names).toContain("update-invoice");
      expect(names).toContain("list-invoice-attachments");
      expect(names).toContain("get-invoice-attachment-content");
      expect(names).toContain("get-invoice-history");
      expect(names).toContain("add-invoice-note");

      const createInvoice = tools.find((tool) => tool.name === "create-invoice");
      const currencySchema = createInvoice?.inputSchema.properties?.currencyCode;
      expect(currencySchema).toMatchObject({
        enum: expect.arrayContaining(["USD"]),
      });
      expect(createInvoice?.annotations?.readOnlyHint).toBe(false);
      expect(createInvoice?.annotations?.destructiveHint).toBe(true);

      const getInvoiceHistory = tools.find((tool) => tool.name === "get-invoice-history");
      expect(getInvoiceHistory?.annotations?.readOnlyHint).toBe(true);
      expect(getInvoiceHistory?.annotations?.destructiveHint).toBe(false);

      const addInvoiceNote = tools.find((tool) => tool.name === "add-invoice-note");
      expect(addInvoiceNote?.annotations?.readOnlyHint).toBe(false);
      expect(addInvoiceNote?.annotations?.destructiveHint).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});
