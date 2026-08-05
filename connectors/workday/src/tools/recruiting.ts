/**
 * Workday recruiting tools — list job requisitions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { JOB_REQUISITION_FIELDS, NESTED_OBJECT_FIELDS, paginationLimitSchema, paginationOffsetSchema, pickFields, paginationHint } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured, getRecruitingApiFamily } from '../auth.js';
import { workdayFetch } from '../client.js';

const NESTED_REFERENCE_FIELDS = ['supervisoryOrganization', 'hiringManager', 'primaryLocation', 'jobProfile'] as const;

export function registerRecruitingTools(server: McpServer): void {
  server.registerTool(
    'list_workday_job_requisitions',
    {
      description: `List job requisitions (open roles being hired for) in Workday recruiting.

Returns per requisition: ID, title/descriptor, status, number of openings,
hiring manager, supervisory organization, primary location, job profile.
Description and other free-text fields are deliberately excluded.

Example: {}
Example: { "limit": 25, "offset": 50 }

REQUIRED PERMISSIONS:
- The ISU's security group needs access to the Recruiting domain
  (Job Requisitions), otherwise Workday returns 403.
- The recruiting REST family is versioned by Workday platform release. The
  connector defaults to v41.2; if the tenant exposes a different version
  (404s), set WORKDAY_RECRUITING_API_VERSION (e.g. "v42.1").

RELATED TOOLS:
- list_workday_organizations: Browse the orgs a requisition belongs to
- list_workday_jobs: See current worker job assignments`,
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
        `/jobRequisitions?${params.toString()}`,
        {},
        0,
        getRecruitingApiFamily(),
      );

      const requisitions = (result.data || []).map((req) => {
        const filtered = pickFields(req, JOB_REQUISITION_FIELDS);
        for (const field of NESTED_REFERENCE_FIELDS) {
          if (req[field] && typeof req[field] === 'object') {
            filtered[field] = pickFields(req[field] as Record<string, unknown>, NESTED_OBJECT_FIELDS);
          }
        }
        return filtered;
      });
      const total = result.total ?? requisitions.length;
      const hint = paginationHint(total, offset, requisitions.length);

      return JSON.stringify({ ok: true, job_requisitions: requisitions, count: requisitions.length, total, pagination: hint });
    }),
  );
}
