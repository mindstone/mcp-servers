import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetShortCode = vi.fn();

async function importWithMockedClient() {
  vi.resetModules();
  mockGetShortCode.mockReset();

  vi.doMock("../src/clients/xero-client.js", () => ({
    xeroClient: {
      tenantId: "tenant-1",
      getShortCode: mockGetShortCode,
    },
  }));

  return await import("../src/helpers/get-deeplink.js");
}

describe("getDeepLink", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a deep link when the short code resolves", async () => {
    const { getDeepLink, DeepLinkType } = await importWithMockedClient();
    mockGetShortCode.mockResolvedValue("abc123");

    const link = await getDeepLink(DeepLinkType.CONTACT, "contact-1");

    expect(link).toBe(
      " https://go.xero.com/app/abc123/contacts/contact/contact-1",
    );
  });

  it("returns null instead of throwing when the short code lookup fails", async () => {
    const { getDeepLink, DeepLinkType } = await importWithMockedClient();
    mockGetShortCode.mockRejectedValue(new Error("identity endpoint down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const link = await getDeepLink(DeepLinkType.INVOICE, "invoice-1");

    expect(link).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns null when the organisation has no short code", async () => {
    const { getDeepLink, DeepLinkType } = await importWithMockedClient();
    mockGetShortCode.mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const link = await getDeepLink(DeepLinkType.INVOICE, "invoice-1");

    expect(link).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not leak credentials from a failed short code lookup into logs", async () => {
    const { getDeepLink, DeepLinkType } = await importWithMockedClient();
    mockGetShortCode.mockRejectedValue(
      new Error(
        "Failed to get Organisation short code: An unexpected error occurred while communicating with Xero.",
      ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await getDeepLink(DeepLinkType.PAYMENT, "payment-1");

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain("Bearer");
  });
});
