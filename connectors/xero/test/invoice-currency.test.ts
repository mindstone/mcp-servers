import { beforeEach, describe, expect, it, vi } from "vitest";
import { CurrencyCode, Invoice } from "xero-node";

const mockAuthenticate = vi.fn();
const mockCreateInvoices = vi.fn();
const mockGetInvoice = vi.fn();
const mockUpdateInvoice = vi.fn();

async function importWithMockedClient() {
  vi.resetModules();
  mockAuthenticate.mockReset();
  mockCreateInvoices.mockReset();
  mockGetInvoice.mockReset();
  mockUpdateInvoice.mockReset();

  vi.doMock("../src/clients/xero-client.js", () => ({
    xeroClient: {
      tenantId: "tenant-1",
      authenticate: mockAuthenticate,
      accountingApi: {
        createInvoices: mockCreateInvoices,
        getInvoice: mockGetInvoice,
        updateInvoice: mockUpdateInvoice,
      },
    },
  }));

  const createHandler = await import("../src/handlers/create-xero-invoice.handler.js");
  const updateHandler = await import("../src/handlers/update-xero-invoice.handler.js");
  const createTool = await import("../src/tools/create/create-invoice.tool.js");
  const updateTool = await import("../src/tools/update/update-invoice.tool.js");

  return {
    createXeroInvoice: createHandler.createXeroInvoice,
    updateXeroInvoice: updateHandler.updateXeroInvoice,
    createInvoiceTool: createTool.default,
    updateInvoiceTool: updateTool.default,
  };
}

const lineItems = [
  {
    description: "Consulting",
    quantity: 1,
    unitAmount: 399,
    accountCode: "200",
    taxType: "NONE",
  },
];

describe("invoice currency support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes optional currencyCode on create and update tool schemas", async () => {
    const { createInvoiceTool, updateInvoiceTool } = await importWithMockedClient();

    const createSchema = createInvoiceTool().schema;
    const updateSchema = updateInvoiceTool().schema;

    expect(createSchema.currencyCode.safeParse("USD").success).toBe(true);
    expect(updateSchema.currencyCode.safeParse("USD").success).toBe(true);
    expect(createSchema.currencyCode.safeParse("usd").success).toBe(false);
    expect(updateSchema.currencyCode.safeParse("US").success).toBe(false);
  });

  it("passes currencyCode when creating an invoice", async () => {
    const { createXeroInvoice } = await importWithMockedClient();
    mockCreateInvoices.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv-1",
            type: Invoice.TypeEnum.ACCREC,
            status: Invoice.StatusEnum.DRAFT,
            currencyCode: CurrencyCode.USD,
          },
        ],
      },
    });

    const result = await createXeroInvoice(
      "contact-1",
      lineItems,
      Invoice.TypeEnum.ACCREC,
      "INV-USD",
      "2026-06-08",
      CurrencyCode.USD,
    );

    expect(result.isError).toBe(false);
    expect(mockCreateInvoices).toHaveBeenCalledOnce();
    const invoicesArg = mockCreateInvoices.mock.calls[0]?.[1] as {
      invoices: Array<{ currencyCode?: string }>;
    };
    expect(invoicesArg.invoices[0]?.currencyCode).toBe(CurrencyCode.USD);
  });

  it("omits currencyCode when creating an invoice without one", async () => {
    const { createXeroInvoice } = await importWithMockedClient();
    mockCreateInvoices.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv-1",
            type: Invoice.TypeEnum.ACCREC,
            status: Invoice.StatusEnum.DRAFT,
          },
        ],
      },
    });

    const result = await createXeroInvoice(
      "contact-1",
      lineItems,
      Invoice.TypeEnum.ACCREC,
    );

    expect(result.isError).toBe(false);
    const invoicesArg = mockCreateInvoices.mock.calls[0]?.[1] as {
      invoices: Array<{ currencyCode?: string }>;
    };
    expect(invoicesArg.invoices[0]).not.toHaveProperty("currencyCode");
  });

  it("passes currencyCode when updating a draft invoice", async () => {
    const { updateXeroInvoice } = await importWithMockedClient();
    mockGetInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv-1",
            status: Invoice.StatusEnum.DRAFT,
          },
        ],
      },
    });
    mockUpdateInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv-1",
            status: Invoice.StatusEnum.DRAFT,
            currencyCode: CurrencyCode.USD,
          },
        ],
      },
    });

    const result = await updateXeroInvoice(
      "inv-1",
      lineItems,
      "INV-USD",
      "2026-07-08",
      "2026-06-08",
      "contact-1",
      CurrencyCode.USD,
    );

    expect(result.isError).toBe(false);
    expect(mockUpdateInvoice).toHaveBeenCalledOnce();
    const invoicesArg = mockUpdateInvoice.mock.calls[0]?.[2] as {
      invoices: Array<{ currencyCode?: string }>;
    };
    expect(invoicesArg.invoices[0]?.currencyCode).toBe(CurrencyCode.USD);
  });

  it("refuses non-draft invoice updates before sending currencyCode", async () => {
    const { updateXeroInvoice } = await importWithMockedClient();
    mockGetInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv-1",
            status: Invoice.StatusEnum.AUTHORISED,
          },
        ],
      },
    });

    const result = await updateXeroInvoice(
      "inv-1",
      lineItems,
      undefined,
      undefined,
      undefined,
      undefined,
      CurrencyCode.USD,
    );

    expect(result.isError).toBe(true);
    expect(mockUpdateInvoice).not.toHaveBeenCalled();
    expect(result.error).toContain("not a draft");
  });
});
