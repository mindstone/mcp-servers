import { describe, expect, it, vi } from "vitest";

const mockAuthenticate = vi.fn();
const mockGetReportProfitAndLoss = vi.fn();

vi.mock("../src/clients/xero-client.js", () => ({
  xeroClient: {
    tenantId: "tenant-1",
    authenticate: mockAuthenticate,
    accountingApi: {
      getReportProfitAndLoss: mockGetReportProfitAndLoss,
    },
  },
}));

const { default: listProfitAndLossTool } = await import(
  "../src/tools/list/list-profit-and-loss.tool.js"
);

describe("list-profit-and-loss", () => {
  it("passes standardLayout and paymentsOnly to Xero in their own places", async () => {
    mockGetReportProfitAndLoss.mockResolvedValue({
      body: { reports: [{ reportName: "Profit and Loss", rows: [] }] },
    });

    await listProfitAndLossTool().handler(
      {
        fromDate: "2026-01-01",
        toDate: "2026-03-31",
        periods: 2,
        timeframe: "MONTH",
        standardLayout: false,
        paymentsOnly: true,
      },
      {} as never,
    );

    expect(mockGetReportProfitAndLoss).toHaveBeenCalledOnce();
    const args = mockGetReportProfitAndLoss.mock.calls[0]!;
    // tenantId, fromDate, toDate, periods, timeframe, then four tracking ids.
    expect(args.slice(0, 9)).toEqual([
      "tenant-1",
      "2026-01-01",
      "2026-03-31",
      2,
      "MONTH",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const [standardLayout, paymentsOnly] = args.slice(9, 11);
    expect(standardLayout).toBe(false);
    expect(paymentsOnly).toBe(true);
  });
});
