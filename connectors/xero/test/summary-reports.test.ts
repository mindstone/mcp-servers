import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthenticate = vi.fn();
const mockGetReportBankSummary = vi.fn();
const mockGetReportBudgetSummary = vi.fn();
const mockGetReportExecutiveSummary = vi.fn();

async function importWithMockedClient() {
  vi.resetModules();
  mockAuthenticate.mockReset();
  mockGetReportBankSummary.mockReset();
  mockGetReportBudgetSummary.mockReset();
  mockGetReportExecutiveSummary.mockReset();

  vi.doMock("../src/clients/xero-client.js", () => ({
    xeroClient: {
      tenantId: "tenant-1",
      authenticate: mockAuthenticate,
      accountingApi: {
        getReportBankSummary: mockGetReportBankSummary,
        getReportBudgetSummary: mockGetReportBudgetSummary,
        getReportExecutiveSummary: mockGetReportExecutiveSummary,
      },
    },
  }));

  const bankSummaryTool = await import(
    "../src/tools/list/list-bank-summary.tool.js"
  );
  const budgetSummaryTool = await import(
    "../src/tools/list/list-budget-summary.tool.js"
  );
  const executiveSummaryTool = await import(
    "../src/tools/list/list-executive-summary.tool.js"
  );

  return {
    listBankSummaryTool: bankSummaryTool.default,
    listBudgetSummaryTool: budgetSummaryTool.default,
    listExecutiveSummaryTool: executiveSummaryTool.default,
  };
}

function reportPayload(reportName: string) {
  return {
    body: {
      reports: [
        {
          reportName,
          rows: [{ rowType: "Row", cells: [{ value: "100.00" }] }],
        },
      ],
    },
  };
}

function textOf(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (result.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

describe("summary report tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("list-bank-summary passes dates and returns enveloped report rows", async () => {
    const { listBankSummaryTool } = await importWithMockedClient();
    mockGetReportBankSummary.mockResolvedValue(reportPayload("Bank Summary"));

    const result = await listBankSummaryTool().handler(
      { fromDate: "2026-01-01", toDate: "2026-01-31" },
      {} as never,
    );

    expect(mockGetReportBankSummary).toHaveBeenCalledOnce();
    const [tenantId, fromDate, toDate] = mockGetReportBankSummary.mock.calls[0]!;
    expect(tenantId).toBe("tenant-1");
    expect(fromDate).toBe("2026-01-01");
    expect(toDate).toBe("2026-01-31");

    const text = textOf(result);
    expect(text).toContain("Bank Summary Report: Bank Summary");
    expect(text).toContain("100.00");
    expect(text).toContain('<untrusted-content source="xero.list-bank-summary">');
  });

  it("list-budget-summary maps the timeframe enum to Xero's month count", async () => {
    const { listBudgetSummaryTool } = await importWithMockedClient();
    mockGetReportBudgetSummary.mockResolvedValue(
      reportPayload("Budget Summary"),
    );

    const result = await listBudgetSummaryTool().handler(
      { date: "2026-03-31", periods: 4, timeframe: "QUARTER" },
      {} as never,
    );

    expect(mockGetReportBudgetSummary).toHaveBeenCalledOnce();
    const [tenantId, date, periods, timeframe] =
      mockGetReportBudgetSummary.mock.calls[0]!;
    expect(tenantId).toBe("tenant-1");
    expect(date).toBe("2026-03-31");
    expect(periods).toBe(4);
    expect(timeframe).toBe(3);

    expect(textOf(result)).toContain("Budget Summary Report: Budget Summary");
  });

  it("list-executive-summary returns the report rows", async () => {
    const { listExecutiveSummaryTool } = await importWithMockedClient();
    mockGetReportExecutiveSummary.mockResolvedValue(
      reportPayload("Executive Summary"),
    );

    const result = await listExecutiveSummaryTool().handler(
      { date: "2026-03-31" },
      {} as never,
    );

    expect(mockGetReportExecutiveSummary).toHaveBeenCalledOnce();
    expect(mockGetReportExecutiveSummary.mock.calls[0]![1]).toBe("2026-03-31");
    expect(textOf(result)).toContain(
      "Executive Summary Report: Executive Summary",
    );
  });

  it("surfaces an error when Xero returns no report", async () => {
    const { listBankSummaryTool } = await importWithMockedClient();
    mockGetReportBankSummary.mockResolvedValue({ body: { reports: [] } });

    const result = await listBankSummaryTool().handler({}, {} as never);

    expect(textOf(result)).toContain(
      "Error getting bank summary report: Failed to fetch bank summary data from Xero.",
    );
  });

  it("surfaces a formatted error when the API call fails", async () => {
    const { listExecutiveSummaryTool } = await importWithMockedClient();
    mockGetReportExecutiveSummary.mockRejectedValue(new Error("boom"));

    const result = await listExecutiveSummaryTool().handler({}, {} as never);

    expect(textOf(result)).toContain("Error getting executive summary report:");
  });

  it("rejects malformed dates in the exported schema", async () => {
    const { listBankSummaryTool } = await importWithMockedClient();
    const schema = listBankSummaryTool().schema;

    expect(schema.fromDate.safeParse("2026-01-01").success).toBe(true);
    expect(schema.fromDate.safeParse("01/01/2026").success).toBe(false);
    expect(schema.timeframe).toBeUndefined();
  });
});
