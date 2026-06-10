import { beforeEach, describe, expect, it, vi } from "vitest";
import { CurrencyCode, Invoice } from "xero-node";

const mockAuthenticate = vi.fn();
const mockCreateInvoices = vi.fn();
const mockGetCurrencies = vi.fn();
const mockGetInvoice = vi.fn();
const mockUpdateInvoice = vi.fn();

async function importWithMockedClient() {
  vi.resetModules();
  mockAuthenticate.mockReset();
  mockCreateInvoices.mockReset();
  mockGetCurrencies.mockReset();
  mockGetInvoice.mockReset();
  mockUpdateInvoice.mockReset();

  vi.doMock("../src/clients/xero-client.js", () => ({
    xeroClient: {
      tenantId: "tenant-1",
      authenticate: mockAuthenticate,
      accountingApi: {
        createInvoices: mockCreateInvoices,
        getCurrencies: mockGetCurrencies,
        getInvoice: mockGetInvoice,
        updateInvoice: mockUpdateInvoice,
      },
    },
  }));

  const createHandler = await import("../src/handlers/create-xero-invoice.handler.js");
  const updateHandler = await import("../src/handlers/update-xero-invoice.handler.js");
  const createTool = await import("../src/tools/create/create-invoice.tool.js");
  const listCurrenciesTool = await import("../src/tools/list/list-currencies.tool.js");
  const updateTool = await import("../src/tools/update/update-invoice.tool.js");

  return {
    createXeroInvoice: createHandler.createXeroInvoice,
    updateXeroInvoice: updateHandler.updateXeroInvoice,
    createInvoiceTool: createTool.default,
    listCurrenciesTool: listCurrenciesTool.default,
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
    mockGetCurrencies.mockResolvedValue({
      body: {
        currencies: [
          {
            code: CurrencyCode.USD,
            description: "United States Dollar",
          },
        ],
      },
    });
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
    expect(mockGetCurrencies).toHaveBeenCalledOnce();
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
    expect(mockGetCurrencies).not.toHaveBeenCalled();
    const invoicesArg = mockCreateInvoices.mock.calls[0]?.[1] as {
      invoices: Array<{ currencyCode?: string }>;
    };
    expect(invoicesArg.invoices[0]).not.toHaveProperty("currencyCode");
  });

  it("refuses create when the requested currency is not enabled in Xero", async () => {
    const { createXeroInvoice } = await importWithMockedClient();
    mockGetCurrencies.mockResolvedValue({
      body: {
        currencies: [
          {
            code: CurrencyCode.USD,
            description: "United States Dollar",
          },
        ],
      },
    });

    const result = await createXeroInvoice(
      "contact-1",
      lineItems,
      Invoice.TypeEnum.ACCREC,
      "INV-GBP",
      "2026-06-08",
      CurrencyCode.GBP,
    );

    expect(result.isError).toBe(true);
    expect(result.error).toContain("Currency GBP is not enabled");
    expect(result.error).toContain("Enabled currencies: USD");
    expect(mockCreateInvoices).not.toHaveBeenCalled();
  });

  it("surfaces Xero validation details when invoice creation is rejected", async () => {
    const { createXeroInvoice } = await importWithMockedClient();
    mockGetCurrencies.mockResolvedValue({
      body: {
        currencies: [
          {
            code: CurrencyCode.USD,
            description: "United States Dollar",
          },
        ],
      },
    });
    mockCreateInvoices.mockRejectedValue(
      JSON.stringify({
        response: {
          statusCode: 400,
          body: {
            Type: "ValidationException",
            Message: "A validation exception occurred",
            Elements: [
              {
                ValidationErrors: [
                  {
                    Message: "Account code 200 is not valid for this invoice.",
                  },
                ],
              },
            ],
          },
          headers: { "set-cookie": "secret-cookie" },
          request: {
            headers: { authorization: "Bearer SECRET" },
          },
        },
      }),
    );

    const result = await createXeroInvoice(
      "contact-1",
      lineItems,
      Invoice.TypeEnum.ACCREC,
      "INV-USD",
      "2026-06-08",
      CurrencyCode.USD,
    );

    expect(result.isError).toBe(true);
    expect(result.error).toContain("Account code 200 is not valid");
    expect(result.error).not.toContain("Bearer");
    expect(result.error).not.toContain("secret-cookie");
  });

  it("lists enabled currencies", async () => {
    const { listCurrenciesTool } = await importWithMockedClient();
    mockGetCurrencies.mockResolvedValue({
      body: {
        currencies: [
          {
            code: CurrencyCode.USD,
            description: "United States Dollar",
          },
        ],
      },
    });

    const result = await listCurrenciesTool().handler({}, {} as never);

    expect(mockGetCurrencies).toHaveBeenCalledOnce();
    expect(result.content?.map((content) => content.type === "text" ? content.text : "").join("\n")).toContain(
      "Currency: USD",
    );
  });

  it("passes currencyCode when updating a draft invoice", async () => {
    const { updateXeroInvoice } = await importWithMockedClient();
    mockGetCurrencies.mockResolvedValue({
      body: {
        currencies: [
          {
            code: CurrencyCode.USD,
            description: "United States Dollar",
          },
        ],
      },
    });
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
    expect(mockGetCurrencies).toHaveBeenCalledOnce();
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

  it("refuses update when the requested currency is not enabled in Xero", async () => {
    const { updateXeroInvoice } = await importWithMockedClient();
    mockGetCurrencies.mockResolvedValue({
      body: {
        currencies: [
          {
            code: CurrencyCode.USD,
            description: "United States Dollar",
          },
        ],
      },
    });
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

    const result = await updateXeroInvoice(
      "inv-1",
      lineItems,
      "INV-GBP",
      "2026-07-08",
      "2026-06-08",
      "contact-1",
      CurrencyCode.GBP,
    );

    expect(result.isError).toBe(true);
    expect(result.error).toContain("Currency GBP is not enabled");
    expect(mockUpdateInvoice).not.toHaveBeenCalled();
  });
});
