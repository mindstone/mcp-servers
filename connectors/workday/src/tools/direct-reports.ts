/**
 * Workday direct reports tool — list a worker's direct reports (org chart).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WORKER_LIST_FIELDS, pickFields, paginationHint } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { workdayFetch } from '../client.js';

export function registerDirectReportTools(server: McpServer): void {
  server.registerTool(
    'list_workday_direct_reports',
    {
      description: `List a worker's direct reports in Workday (one level of the org chart).

Returns compact worker summaries: ID, name, email, title, manager status.

Example: { "worker_id": "3aa5550b7fe348b98d7b5741afc65534" }

WORKFLOW - To explore the org chart:
1. Call list_workday_workers to find a manager by name
2. Pass their id here to list their team
3. Call again with a report's id to walk deeper

RELATED TOOLS:
- list_workday_workers: Search/browse workers to find IDs
- get_workday_worker: Full profile for one worker`,
      inputSchema: z.object({
        worker_id: z.string().describe('Worker ID of the manager (from list_workday_workers)'),
        limit: z.number().optional().describe('Max results per page (default 50, max 100)'),
        offset: z.number().optional().describe('Number of results to skip (for pagination, default 0)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) {
        return JSON.stringify({
          ok: false,
          error: 'Workday not configured',
          resolution: 'Configure Workday with your OAuth credentials first.',
          next_step: {
            action: 'The user adds the Workday credentials in Settings → Connectors in the app. Do not ask for it in chat.',
          },
        });
      }

      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);

      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(offset));

      const result = await workdayFetch<{ data: Record<string, unknown>[]; total: number }>(
        `/workers/${encodeURIComponent(args.worker_id)}/directReports?${params.toString()}`,
      );

      const reports = (result.data || []).map((w) => pickFields(w, WORKER_LIST_FIELDS));
      const total = result.total || reports.length;
      const hint = paginationHint(total, offset, reports.length);

      return JSON.stringify({ ok: true, direct_reports: reports, count: reports.length, total, pagination: hint });
    }),
  );
}
