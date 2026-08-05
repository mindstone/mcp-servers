import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { ReportWithRow } from "xero-node";

async function fetchBankSummary(
  fromDate?: string,
  toDate?: string,
): Promise<ReportWithRow | null> {
  await xeroClient.authenticate();

  const response = await xeroClient.accountingApi.getReportBankSummary(
    xeroClient.tenantId,
    fromDate,
    toDate,
    getClientHeaders(),
  );

  return response.body.reports?.[0] ?? null;
}

/**
 * Get the bank summary report from Xero (opening/closing balances and
 * movements per bank account over a period).
 * @param fromDate Optional start date for the report (YYYY-MM-DD)
 * @param toDate Optional end date for the report (YYYY-MM-DD)
 */
export async function listXeroBankSummary(
  fromDate?: string,
  toDate?: string,
): Promise<XeroClientResponse<ReportWithRow>> {
  try {
    const report = await fetchBankSummary(fromDate, toDate);

    if (!report) {
      return {
        result: null,
        isError: true,
        error: "Failed to fetch bank summary data from Xero.",
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
