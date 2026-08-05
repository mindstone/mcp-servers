/**
 * QuickBooks financial report tools.
 *
 * Reports are served from the dedicated /reports/{ReportName} endpoint (not
 * reachable via the /query data service). Date-range reports take
 * start_date/end_date; aging reports take report_date (as-of date).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import { qboFetch } from '../client.js';
import { QBO_MINOR_VERSION } from '../types.js';
import { wrapUntrustedJsonStrings } from '../untrusted-content.js';

const RANGE_REPORTS = ['ProfitAndLoss', 'BalanceSheet', 'CashFlow'] as const;
const AGING_REPORTS = ['AgedReceivables', 'AgedPayables'] as const;

const REPORT_NAMES = [...RANGE_REPORTS, ...AGING_REPORTS] as const;
type ReportName = (typeof REPORT_NAMES)[number];

export function registerReportTools(server: McpServer): void {
  server.registerTool(
    'get_quickbooks_report',
    {
      description: `Run a financial report from QuickBooks Online.

Reports available: ProfitAndLoss, BalanceSheet, CashFlow, AgedReceivables, AgedPayables.

Example: { "report": "ProfitAndLoss", "startDate": "2026-01-01", "endDate": "2026-03-31" }
Example: { "report": "AgedReceivables", "asOfDate": "2026-03-31" }

WORKFLOW:
1. ProfitAndLoss / BalanceSheet / CashFlow cover a date range (startDate + endDate)
2. AgedReceivables / AgedPayables are as-of a single date (asOfDate)
3. Dates use YYYY-MM-DD format; omitted dates use the QuickBooks default period`,
      inputSchema: z.object({
        report: z.enum(REPORT_NAMES).describe('Report to run'),
        startDate: z.string().optional()
          .describe('Report start date (YYYY-MM-DD) — range reports only'),
        endDate: z.string().optional()
          .describe('Report end date (YYYY-MM-DD) — range reports only'),
        asOfDate: z.string().optional()
          .describe('As-of date (YYYY-MM-DD) — aging reports only'),
        accountingMethod: z.enum(['Accrual', 'Cash']).optional()
          .describe('Accounting method for the report (default: company setting)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const params = new URLSearchParams({ minorversion: QBO_MINOR_VERSION });

      if ((AGING_REPORTS as readonly ReportName[]).includes(args.report)) {
        if (args.asOfDate) params.set('report_date', args.asOfDate);
      } else {
        if (args.startDate) params.set('start_date', args.startDate);
        if (args.endDate) params.set('end_date', args.endDate);
      }
      if (args.accountingMethod) params.set('accounting_method', args.accountingMethod);

      const report = await qboFetch<Record<string, unknown>>(
        `/reports/${args.report}?${params.toString()}`,
      );
      // Arbitrary report shape: envelope every string value wholesale.
      return JSON.stringify({
        ok: true,
        report: wrapUntrustedJsonStrings(report, `quickbooks:get_quickbooks_report:${args.report}`),
      });
    }),
  );
}
