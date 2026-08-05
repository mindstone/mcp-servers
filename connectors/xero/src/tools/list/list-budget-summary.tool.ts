import { z } from "zod";
import { listXeroBudgetSummary } from "../../handlers/list-xero-budget-summary.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ListBudgetSummaryTool = CreateXeroTool(
  "list-budget-summary",
  "Get the budget summary report from Xero: budgeted vs actual figures per account. Useful for 'are we tracking to budget?' questions. Requires budgets to be set up in the Xero organisation.",
  {
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
      .optional()
      .describe("Optional date for the report (YYYY-MM-DD)"),
    periods: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe("Optional number of periods to compare (1-12)"),
    timeframe: z
      .enum(["MONTH", "QUARTER", "YEAR"])
      .optional()
      .describe("Optional period size to compare (MONTH, QUARTER, YEAR)"),
  },
  async ({ date, periods, timeframe }) => {
    const response = await listXeroBudgetSummary(date, periods, timeframe);

    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error getting budget summary report: ${response.error}`,
          },
        ],
      };
    }

    const report = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: `Budget Summary Report: ${report?.reportName ?? "Unnamed"}`,
        },
        {
          type: "text" as const,
          text: JSON.stringify(report.rows, null, 2),
        },
      ],
    };
  },
);

export default ListBudgetSummaryTool;
