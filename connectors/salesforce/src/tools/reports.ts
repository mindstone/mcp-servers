import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, sanitizeExternalData } from '../utils.js';
import { withConnection } from '../client.js';
import { ConnectorError } from '../types.js';

export function registerReportTools(server: McpServer): void {
  server.registerTool(
    'salesforce_run_report',
    {
      description: `Run an existing Salesforce report (Analytics REST API) and return its aggregated result. Required: report_id (the report's 15- or 18-character ID, visible in the report URL). Set include_details=true to include detail rows, not just groupings and aggregates.`,
      inputSchema: z.object({
        report_id: z.string().min(1).describe('Salesforce report ID (15 or 18 characters, from the report URL)'),
        include_details: z.boolean().optional().describe('Include detail rows in the result (default: false — groupings and aggregates only)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!/^[a-zA-Z0-9]{15,18}$/.test(args.report_id)) {
        throw new ConnectorError(
          `Invalid report_id: "${args.report_id}"`,
          'INVALID_REPORT_ID',
          'Report IDs are 15- or 18-character alphanumeric Salesforce IDs (e.g. "00O1a000005xYZ1AAM"), visible at the end of the report URL',
        );
      }
      return withConnection(undefined, async (conn) => {
        const result = await conn.analytics
          .report(args.report_id)
          .execute({ details: args.include_details === true });
        // Everything in a report result (name, group labels, cell values) is
        // org-authored text — envelope it. factMap keys (T!T, 0!0) are
        // structural and stay raw; object keys are never enveloped.
        return JSON.stringify({
          ok: true,
          report: sanitizeExternalData(
            {
              reportMetadata: result.reportMetadata,
              reportExtendedMetadata: result.reportExtendedMetadata,
              factMap: result.factMap,
              groupingsDown: result.groupingsDown,
              groupingsAcross: result.groupingsAcross,
              hasDetailRows: result.hasDetailRows,
              allData: result.allData,
            },
            'salesforce:run_report:report',
          ),
        });
      });
    }),
  );
}
