import { beforeEach, describe, expect, it, vi } from "vitest";
import { CurrencyCode, PurchaseOrder } from "xero-node";

const mockAuthenticate = vi.fn();
const mockGetPurchaseOrders = vi.fn();
const mockCreatePurchaseOrders = vi.fn();
const mockGetCurrencies = vi.fn();

async function importWithMockedClient() {
  vi.resetModules();
  mockAuthenticate.mockReset();
  mockGetPurchaseOrders.mockReset();
  mockCreatePurchaseOrders.mockReset();
  mockGetCurrencies.mockReset();

  vi.doMock("../src/clients/xero-client.js", () => ({
    xeroClient: {
      tenantId: "tenant-1",
      authenticate: mockAuthenticate,
      accountingApi: {
        getPurchaseOrders: mockGetPurchaseOrders,
        createPurchaseOrders: mockCreatePurchaseOrders,
        getCurrencies: mockGetCurrencies,
      },
    },
  }));

  const listTool = await import(
    "../src/tools/list/list-purchase-orders.tool.js"
  );
  const createTool = await import(
    "../src/tools/create/create-purchase-order.tool.js"
  );

  return {
    listPurchaseOrdersTool: listTool.default,
    createPurchaseOrderTool: createTool.default,
  };
}

const lineItems = [
  {
    description: "Office supplies",
    quantity: 2,
    unitAmount: 50,
    accountCode: "429",
    taxType: "NONE",
  },
];

function textOf(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (result.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

describe("list-purchase-orders tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes filters and renders the purchase orders", async () => {
    const { listPurchaseOrdersTool } = await importWithMockedClient();
    mockGetPurchaseOrders.mockResolvedValue({
      body: {
        purchaseOrders: [
          {
            purchaseOrderID: "po-1",
            purchaseOrderNumber: "PO-0001",
            status: PurchaseOrder.StatusEnum.AUTHORISED,
            contact: { contactID: "contact-1", name: "Acme Corp" },
            date: "2026-07-01",
            total: 100,
          },
        ],
      },
    });

    const result = await listPurchaseOrdersTool().handler(
      {
        page: 1,
        status: "AUTHORISED",
        dateFrom: "2026-07-01",
        dateTo: "2026-07-31",
        orderBy: "Date",
        orderDirection: "DESC",
        pageSize: 50,
      },
      {} as never,
    );

    expect(mockGetPurchaseOrders).toHaveBeenCalledOnce();
    const call = mockGetPurchaseOrders.mock.calls[0]!;
    expect(call[0]).toBe("tenant-1");
    expect(call[2]).toBe("AUTHORISED");
    expect(call[3]).toBe("2026-07-01");
    expect(call[4]).toBe("2026-07-31");
    expect(call[5]).toBe("Date DESC");
    expect(call[6]).toBe(1);
    expect(call[7]).toBe(50);

    const text = textOf(result);
    expect(text).toContain("Found 1 purchase orders:");
    expect(text).toContain("Purchase Order: PO-0001");
    expect(text).toContain("Contact: Acme Corp (contact-1)");
    expect(text).toContain(
      '<untrusted-content source="xero.list-purchase-orders">',
    );
  });

  it("warns there may be more pages when results equal pageSize", async () => {
    const { listPurchaseOrdersTool } = await importWithMockedClient();
    mockGetPurchaseOrders.mockResolvedValue({
      body: {
        purchaseOrders: [
          { purchaseOrderID: "po-1", purchaseOrderNumber: "PO-0001" },
          { purchaseOrderID: "po-2", purchaseOrderNumber: "PO-0002" },
        ],
      },
    });

    const result = await listPurchaseOrdersTool().handler(
      { pageSize: 2 },
      {} as never,
    );

    expect(textOf(result)).toContain("there may be more pages");
  });

  it("surfaces a formatted error when the API call fails", async () => {
    const { listPurchaseOrdersTool } = await importWithMockedClient();
    mockGetPurchaseOrders.mockRejectedValue(new Error("boom"));

    const result = await listPurchaseOrdersTool().handler({}, {} as never);

    expect(textOf(result)).toContain("Error listing purchase orders:");
  });
});

describe("create-purchase-order tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a DRAFT purchase order by default", async () => {
    const { createPurchaseOrderTool } = await importWithMockedClient();
    mockCreatePurchaseOrders.mockResolvedValue({
      body: {
        purchaseOrders: [
          {
            purchaseOrderID: "po-1",
            purchaseOrderNumber: "PO-0001",
            status: PurchaseOrder.StatusEnum.DRAFT,
            contact: { contactID: "contact-1", name: "Acme Corp" },
            total: 100,
          },
        ],
      },
    });

    const result = await createPurchaseOrderTool().handler(
      { contactId: "contact-1", lineItems },
      {} as never,
    );

    expect(mockCreatePurchaseOrders).toHaveBeenCalledOnce();
    const payload = mockCreatePurchaseOrders.mock.calls[0]![1] as {
      purchaseOrders: Array<Record<string, unknown>>;
    };
    expect(payload.purchaseOrders[0]).toMatchObject({
      contact: { contactID: "contact-1" },
      status: PurchaseOrder.StatusEnum.DRAFT,
    });
    expect(payload.purchaseOrders[0]).not.toHaveProperty("currencyCode");
    expect(mockGetCurrencies).not.toHaveBeenCalled();

    const text = textOf(result);
    expect(text).toContain("Purchase order created successfully:");
    expect(text).toContain("ID: po-1");
  });

  it("validates the requested currency against the organisation", async () => {
    const { createPurchaseOrderTool } = await importWithMockedClient();
    mockGetCurrencies.mockResolvedValue({
      body: {
        currencies: [{ code: CurrencyCode.USD, description: "US Dollar" }],
      },
    });

    const result = await createPurchaseOrderTool().handler(
      { contactId: "contact-1", lineItems, currencyCode: CurrencyCode.GBP },
      {} as never,
    );

    expect(textOf(result)).toContain("Currency GBP is not enabled");
    expect(mockCreatePurchaseOrders).not.toHaveBeenCalled();
  });

  it("surfaces a formatted error when creation fails", async () => {
    const { createPurchaseOrderTool } = await importWithMockedClient();
    mockCreatePurchaseOrders.mockRejectedValue(new Error("boom"));

    const result = await createPurchaseOrderTool().handler(
      { contactId: "contact-1", lineItems },
      {} as never,
    );

    expect(textOf(result)).toContain("Error creating purchase order:");
  });
});
