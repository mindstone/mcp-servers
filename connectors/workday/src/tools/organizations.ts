/**
 * Workday organization tools — list organizations.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ORG_LIST_FIELDS, LOCATION_FIELDS, NESTED_OBJECT_FIELDS, pickFields, paginationHint } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import { workdayFetch } from '../client.js';

function notConfiguredResponse(): string {
  return JSON.stringify({
    ok: false,
    error: 'Workday not configured',
    resolution: 'Configure Workday with your OAuth credentials first.',
    next_step: {
      action: 'The user adds the Workday credentials in Settings → Connectors in the app. Do not ask for it in chat.',
    },
  });
}

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
        return notConfiguredResponse();
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

  server.registerTool(
    'list_workday_locations',
    {
      description: `List work locations (offices, sites) in Workday.

Returns per location: ID, name/descriptor, active status, type.
Street addresses and other free-text fields are deliberately excluded.

Example: {}
Example: { "limit": 25, "offset": 50 }

RELATED TOOLS:
- get_workday_worker: See which location a worker is assigned to
- list_workday_job_requisitions: See where open roles are located`,
      inputSchema: z.object({
        limit: z.number().optional().describe('Max results per page (default 50, max 100)'),
        offset: z.number().optional().describe('Number of results to skip (for pagination, default 0)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) {
        return notConfiguredResponse();
      }

      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);

      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(offset));

      const result = await workdayFetch<{ data: Record<string, unknown>[]; total: number }>(
        `/locations?${params.toString()}`,
      );

      const locations = (result.data || []).map((loc) => {
        const filtered = pickFields(loc, LOCATION_FIELDS);
        if (loc.locationType && typeof loc.locationType === 'object') {
          filtered.locationType = pickFields(loc.locationType as Record<string, unknown>, NESTED_OBJECT_FIELDS);
        }
        return filtered;
      });
      const total = result.total || locations.length;
      const hint = paginationHint(total, offset, locations.length);

      return JSON.stringify({ ok: true, locations, count: locations.length, total, pagination: hint });
    }),
  );
}
