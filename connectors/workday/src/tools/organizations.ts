/**
 * Workday organization tools — list organizations.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ORG_LIST_FIELDS, pickFields, paginationHint } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { workdayFetch } from '../client.js';

export function registerOrganizationTools(server: McpServer): void {
  server.registerTool(
    'list_workday_organizations',
    {
      description: `List organizations (departments, supervisory orgs, cost centers, etc.) in Workday.

Returns: ID, name/descriptor, type, active status.

Example: {}
Example: { "limit": 25, "offset": 50 }

Pagination: Returns up to 'limit' results (default 50, max 100). Use 'offset' for next page.

RELATED TOOLS:
- list_workday_workers: Browse workers in the organization
- get_workday_worker: See which organization a worker belongs to`,
      inputSchema: z.object({
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
        `/organizations?${params.toString()}`,
      );

      const organizations = (result.data || []).map((o) => pickFields(o, ORG_LIST_FIELDS));
      const total = result.total || organizations.length;
      const hint = paginationHint(total, offset, organizations.length);

      return JSON.stringify({ ok: true, organizations, count: organizations.length, total, pagination: hint });
    }),
  );
}
