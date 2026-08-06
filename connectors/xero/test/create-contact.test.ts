import { describe, expect, it, vi } from "vitest";

async function importToolWithHandler(handlerImpl: () => Promise<never>) {
  vi.resetModules();
  vi.doMock("../src/clients/xero-client.js", () => ({
    xeroClient: {
      tenantId: "tenant-1",
      getShortCode: vi.fn().mockResolvedValue("abc123"),
    },
  }));
  vi.doMock("../src/handlers/create-xero-contact.handler.js", () => ({
    createXeroContact: handlerImpl,
  }));
  const module = await import("../src/tools/create/create-contact.tool.js");
  return module.default;
}

describe("create-contact tool error formatting", () => {
  it("does not stringify unknown thrown values into the error text", async () => {
    const tool = await importToolWithHandler(async () => {
      // xero-node rejects with a plain object whose request headers can
      // contain bearer tokens; it must never reach the model verbatim.
      throw { request: { headers: { authorization: "Bearer LEAKY_TOKEN" } } };
    });

    const result = await tool().handler({ name: "Acme Corp" }, {} as never);

    const text = (result.content ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    expect(text).toContain(
      "Error creating contact: An unexpected error occurred while communicating with Xero.",
    );
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("LEAKY_TOKEN");
    expect(text).toContain('<untrusted-content source="xero.create-contact">');
  });
});
