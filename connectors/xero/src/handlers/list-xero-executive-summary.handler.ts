import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { ReportWithRow } from "xero-node";

async function fetchExecutiveSummary(
  date?: string,
): Promise<ReportWithRow | null> {
  await xeroClient.authenticate();

  const response = await xeroClient.accountingApi.getReportExecutiveSummary(
    xeroClient.tenantId,
    date,
    getClientHeaders(),
  );

  return response.body.reports?.[0] ?? null;
}

/**
 * Get the executive summary report from Xero (a high-level snapshot of key
 * financial metrics such as cash, debtors, creditors, and profit).
 * @param date Optional date for the report (YYYY-MM-DD)
 */
export async function listXeroExecutiveSummary(
  date?: string,
): Promise<XeroClientResponse<ReportWithRow>> {
  try {
    const report = await fetchExecutiveSummary(date);

    if (!report) {
      return {
        result: null,
        isError: true,
        error: "Failed to fetch executive summary data from Xero.",
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
