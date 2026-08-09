/**
 * Workday jobs tool — list worker job assignments (payroll family).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { JOB_FIELDS, NESTED_OBJECT_FIELDS, PAYROLL_FAMILY, paginationLimitSchema, paginationOffsetSchema, pickFields, paginationHint, sanitizeVendorTotal } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { workdayFetch } from '../client.js';

const NESTED_REFERENCE_FIELDS = ['worker', 'location', 'jobProfile', 'supervisoryOrganization'] as const;

export function registerJobTools(server: McpServer): void {
  server.registerTool(
    'list_workday_jobs',
    {
      description: `List worker job assignments in Workday (position, title, location, organization per job).

Returns per job: ID, business title, job type, worker, location, job profile,
supervisory organization (references trimmed to ID + name).

Example: {}
Example: { "limit": 25, "offset": 50 }

REQUIRED PERMISSIONS:
- The ISU's security group needs access to the Payroll domain that exposes
  the jobs collection (payroll/v2 family), otherwise Workday returns 403.

RELATED TOOLS:
- list_workday_workers: Browse workers directly
- get_workday_worker: Full profile for one worker`,
      inputSchema: z.object({
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
        `/jobs?${params.toString()}`,
        {},
        0,
        PAYROLL_FAMILY,
      );

      const jobs = (result.data || []).map((job) => {
        const filtered = pickFields(job, JOB_FIELDS);
        for (const field of NESTED_REFERENCE_FIELDS) {
          if (job[field] && typeof job[field] === 'object') {
            filtered[field] = pickFields(job[field] as Record<string, unknown>, NESTED_OBJECT_FIELDS);
          }
        }
        return filtered;
      });
      const total = sanitizeVendorTotal(result.total, jobs.length);
      const hint = paginationHint(total, offset, jobs.length);

      return JSON.stringify({ ok: true, jobs, count: jobs.length, total, pagination: hint });
    }),
  );
}
