/**
 * Workday time-off tools — list a worker's time-off entries (absence management).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TIME_OFF_FIELDS,
  NESTED_OBJECT_FIELDS,
  ABSENCE_MANAGEMENT_FAMILY,
  workerIdSchema,
  paginationLimitSchema,
  paginationOffsetSchema,
  pickFields,
  paginationHint,
} from '../types.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { workdayFetch } from '../client.js';

export function registerTimeOffTools(server: McpServer): void {
  server.registerTool(
    'list_workday_time_off',
    {
      description: `List a worker's time-off entries (vacation, sick leave, etc.) from Workday absence management.

Returns per-entry: ID, time-off type, start/end dates, quantity, unit, status.
Comment and reason fields are deliberately excluded from the response.

Example: { "worker_id": "3aa5550b7fe348b98d7b5741afc65534" }

REQUIRED PERMISSIONS:
- The ISU's security group needs access to the Absence Management domain
  (Time Off), otherwise Workday returns 403.

RELATED TOOLS:
- list_workday_workers: Search/browse workers to find IDs
- list_workday_direct_reports: Find a manager's team before checking their time off`,
      inputSchema: z.object({
        worker_id: workerIdSchema.describe('Worker ID (from list_workday_workers)'),
        limit: paginationLimitSchema.optional().describe('Max results per page (default 50, max 100)'),
        offset: paginationOffsetSchema.optional().describe('Number of results to skip (for pagination, default 0)'),
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
        `/workers/${encodeURIComponent(args.worker_id)}/timeOffDetails?${params.toString()}`,
        {},
        0,
        ABSENCE_MANAGEMENT_FAMILY,
      );

      const entries = (result.data || []).map((entry) => {
        const filtered = pickFields(entry, TIME_OFF_FIELDS);
        if (entry.timeOffType && typeof entry.timeOffType === 'object') {
          filtered.timeOffType = pickFields(entry.timeOffType as Record<string, unknown>, NESTED_OBJECT_FIELDS);
        }
        return filtered;
      });
      const total = result.total ?? entries.length;
      const hint = paginationHint(total, offset, entries.length);

      return JSON.stringify({ ok: true, time_off: entries, count: entries.length, total, pagination: hint });
    }),
  );
}
