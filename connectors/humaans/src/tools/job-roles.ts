import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { humaansFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { sanitizeJobRole, sanitizeList } from '../sanitize.js';
import type { HumaansListResponse } from '../types.js';

function paginationHint(total: number, skip: number, count: number): string {
  if (count >= total) return `Showing all ${total} results.`;
  const remaining = total - skip - count;
  return `Showing ${count} of ${total} total (skip=${skip}). ${remaining > 0 ? `Use skip=${skip + count} to see more.` : ''}`;
}

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Humaans API key not configured',
    resolution: 'Use configure_humaans_api_key to set your API key first.',
  });
}

export function registerJobRoleTools(server: McpServer): void {
  server.registerTool(
    'list_humaans_job_roles',
    {
      description:
        `List job role history for employees in Humaans.

Each person can have multiple job roles over time. The role with the most recent
effectiveDate that is not in the future is the current active role.

Use the asOf parameter to find what role someone had at a specific date.

Example: { "personId": "VMB1yzL5uL8VvNNCJc9rykJz" }

RELATED TOOLS:
- list_humaans_people: Find personId to filter by`,
      inputSchema: z.object({
        personId: z.string().optional()
          .describe('Filter by person ID (from list_humaans_people)'),
        asOf: z.string().optional()
          .describe('Find the role in effect on this date (YYYY-MM-DD format)'),
        limit: z.number().min(1).max(250).optional()
          .describe('Max results (default 100, max 250)'),
        skip: z.number().min(0).optional()
          .describe('Number of results to skip'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const limit = Math.min(Math.max(args.limit ?? 100, 1), 250);
      const skip = Math.max(args.skip ?? 0, 0);
      const params = new URLSearchParams();
      params.set('$limit', String(limit));
      params.set('$skip', String(skip));

      if (args.personId) params.set('personId', args.personId);
      if (args.asOf) params.set('$asOf', args.asOf);

      const result = await humaansFetch<HumaansListResponse<Record<string, unknown>>>(
        `/job-roles?${params.toString()}`,
      );

      const hint = paginationHint(result.total, result.skip, result.data.length);
      return JSON.stringify({
        ok: true,
        jobRoles: sanitizeList(result.data, sanitizeJobRole, 'humaans:list_humaans_job_roles'),
        count: result.data.length,
        total: result.total,
        pagination: hint,
      });
    }),
  );

  server.registerTool(
    'get_humaans_job_role',
    {
      description:
        `Get a specific job role by ID from Humaans.

Returns: job title, department, manager (reportingTo), effectiveDate, endDate, note.

Example: { "jobRoleId": "hmA5GnUq9ojK86LLKKWbiuKG" }`,
      inputSchema: z.object({
        jobRoleId: z.string().min(1).describe('The job role ID (from list_humaans_job_roles)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();

      const jobRole = await humaansFetch<Record<string, unknown>>(
        `/job-roles/${encodeURIComponent(args.jobRoleId)}`,
      );
      return JSON.stringify({
        ok: true,
        jobRole: sanitizeJobRole(jobRole, 'humaans:get_humaans_job_role'),
      });
    }),
  );
}
