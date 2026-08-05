import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { ReportWithRow } from "xero-node";

// The SDK takes timeframe as a number of months (1=MONTH, 3=QUARTER, 12=YEAR).
const TIMEFRAME_MONTHS = {
  MONTH: 1,
  QUARTER: 3,
  YEAR: 12,
} as const;

export type BudgetSummaryTimeframe = keyof typeof TIMEFRAME_MONTHS;

async function fetchBudgetSummary(
  date?: string,
  periods?: number,
  timeframe?: BudgetSummaryTimeframe,
): Promise<ReportWithRow | null> {
  await xeroClient.authenticate();

  const response = await xeroClient.accountingApi.getReportBudgetSummary(
    xeroClient.tenantId,
    date,
    periods,
    timeframe ? TIMEFRAME_MONTHS[timeframe] : undefined,
    getClientHeaders(),
  );

  return response.body.reports?.[0] ?? null;
}

/**
 * Get the budget summary report from Xero (budgeted vs actual figures per
 * account).
 * @param date Optional date for the report (YYYY-MM-DD)
 * @param periods Optional number of periods to compare (1-12)
 * @param timeframe Optional period size to compare (MONTH, QUARTER, YEAR)
 */
export async function listXeroBudgetSummary(
  date?: string,
  periods?: number,
  timeframe?: BudgetSummaryTimeframe,
): Promise<XeroClientResponse<ReportWithRow>> {
  try {
    const report = await fetchBudgetSummary(date, periods, timeframe);

    if (!report) {
      return {
        result: null,
        isError: true,
        error: "Failed to fetch budget summary data from Xero.",
      };
    }

    return {
      result: report,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
