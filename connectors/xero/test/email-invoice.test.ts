import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthenticate = vi.fn();
const mockEmailInvoice = vi.fn();

async function importWithMockedClient() {
  vi.resetModules();
  mockAuthenticate.mockReset();
  mockEmailInvoice.mockReset();

  vi.doMock("../src/clients/xero-client.js", () => ({
    xeroClient: {
      tenantId: "tenant-1",
      authenticate: mockAuthenticate,
      accountingApi: {
        emailInvoice: mockEmailInvoice,
      },
    },
  }));

  const tool = await import("../src/tools/update/email-invoice.tool.js");
  return { emailInvoiceTool: tool.default };
}

function textOf(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (result.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

describe("email-invoice tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emails the invoice via the Xero API", async () => {
    const { emailInvoiceTool } = await importWithMockedClient();
    mockEmailInvoice.mockResolvedValue({ body: undefined });

    const result = await emailInvoiceTool().handler(
      { invoiceId: "inv-1" },
      {} as never,
    );

    expect(mockAuthenticate).toHaveBeenCalledOnce();
    expect(mockEmailInvoice).toHaveBeenCalledOnce();
    const [tenantId, invoiceId] = mockEmailInvoice.mock.calls[0]!;
    expect(tenantId).toBe("tenant-1");
    expect(invoiceId).toBe("inv-1");
    expect(textOf(result)).toContain(
      "Invoice inv-1 was emailed to its related contact.",
    );
  });

  it("surfaces a formatted error when Xero rejects the email", async () => {
    const { emailInvoiceTool } = await importWithMockedClient();
    mockEmailInvoice.mockRejectedValue(
      new Error("Invoice not of valid status for modification"),
    );

    const result = await emailInvoiceTool().handler(
      { invoiceId: "inv-draft" },
      {} as never,
    );

    const text = textOf(result);
    expect(text).toContain("Error emailing invoice:");
    expect(text).toContain("Invoice not of valid status");
  });
});
