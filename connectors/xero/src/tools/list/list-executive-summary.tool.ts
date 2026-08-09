import { z } from "zod";
import { listXeroExecutiveSummary } from "../../handlers/list-xero-executive-summary.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ListExecutiveSummaryTool = CreateXeroTool(
  "list-executive-summary",
  "Get the executive summary report from Xero: a high-level snapshot of key financial metrics (cash, debtors, creditors, revenue, profit) for a date. Useful for 'how is the business doing?' questions.",
  {
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
      .optional()
      .describe("Optional date for the report (YYYY-MM-DD)"),
  },
  async ({ date }) => {
    const response = await listXeroExecutiveSummary(date);

    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error getting executive summary report: ${response.error}`,
          },
        ],
        isError: true,
      };
    }

    const report = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: `Executive Summary Report: ${report?.reportName ?? "Unnamed"}`,
        },
        {
          type: "text" as const,
          text: JSON.stringify(report.rows, null, 2),
        },
      ],
    };
  },
);

export default ListExecutiveSummaryTool;
