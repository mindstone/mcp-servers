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

      expect(names).toContain("list-bank-summary");
      expect(names).toContain("list-budget-summary");
      expect(names).toContain("list-executive-summary");
      expect(names).toContain("list-purchase-orders");
      expect(names).toContain("create-purchase-order");
      expect(names).toContain("email-invoice");

      const emailInvoice = tools.find((tool) => tool.name === "email-invoice");
      expect(emailInvoice?.annotations?.readOnlyHint).toBe(false);
      expect(emailInvoice?.annotations?.destructiveHint).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);

  it("runs write tools by default, reaching the Xero API layer", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(connectorRoot, "dist/index.js")],
      cwd: connectorRoot,
      env: childEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "xero-write-default-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "create-invoice",
        arguments: {
          contactId: "00000000-0000-0000-0000-000000000000",
          lineItems: [
            {
              description: "Consulting",
              quantity: 1,
              unitAmount: 100,
              accountCode: "200",
              taxType: "NONE",
            },
          ],
          type: "ACCREC",
        },
      });

      // The tool must attempt the write against Xero (which fails at the API
      // layer with test credentials) rather than refusing up front.
      const text = (result.content as Array<{ type: string; text?: string }>)
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      expect(text).not.toContain("refuses to run");
      expect(text).toContain("Error creating invoice");
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});
