import { z } from "zod";
import { listXeroBankSummary } from "../../handlers/list-xero-bank-summary.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ListBankSummaryTool = CreateXeroTool(
  "list-bank-summary",
  "Get the bank summary report from Xero: opening and closing balances plus total money in/out per bank account over a period. Useful for cash-position questions.",
  {
    fromDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
      .optional()
      .describe("Optional start date of the report period (YYYY-MM-DD)"),
    toDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
      .optional()
      .describe("Optional end date of the report period (YYYY-MM-DD)"),
  },
  async ({ fromDate, toDate }) => {
    const response = await listXeroBankSummary(fromDate, toDate);

    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error getting bank summary report: ${response.error}`,
          },
        ],
      };
    }

    const report = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: `Bank Summary Report: ${report?.reportName ?? "Unnamed"}`,
        },
        {
          type: "text" as const,
          text: JSON.stringify(report.rows, null, 2),
        },
      ],
    };
  },
);

export default ListBankSummaryTool;
