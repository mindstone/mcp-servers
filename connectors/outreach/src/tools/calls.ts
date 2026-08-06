import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import {
  outreachFetch,
  formatResources,
  clampLimit,
  paginationParams,
} from '../client.js';

export function registerCallTools(server: McpServer): void {
  server.registerTool(
    'outreach_list_calls',
    {
      description: `List Outreach calls with direction, outcome, notes, and linked call disposition. Example: { "prospect_id": "123" } or { "user_id": "601" }

Returns calls with state, direction (inbound/outbound), outcome (completed/no_answer),
answered/completed timestamps, notes, and the callDisposition_id linking to the
logged call outcome. Useful for meeting prep and reviewing recent activity.`,
      inputSchema: z.object({
        prospect_id: z.string().optional().describe('Filter calls for a specific prospect'),
        user_id: z.string().optional().describe('Filter calls made by a specific Outreach user'),
        limit: z.number().min(1).max(50).default(25).optional().describe('Max results (default 25, max 50)'),
        page_offset: z.number().min(0).optional().describe('Record offset into the result list for pagination (maps to the API\'s page[offset]; e.g. 25 for the second page with limit 25)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const limit = clampLimit(args.limit);
      const params: Record<string, string> = { ...paginationParams(limit, args.page_offset) };
      if (args.prospect_id) params['filter[prospect][id]'] = args.prospect_id;
      if (args.user_id) params['filter[user][id]'] = args.user_id;

      const response = await outreachFetch('/calls', { params });
      const records = formatResources(response.data);
      return JSON.stringify({
        ok: true,
        records,
        // The API may omit meta.count; fall back to the number of records
        // actually returned rather than reporting a misleading 0.
        count: response.meta?.count ?? records.length,
        page: response.meta?.page,
      });
    }),
  );
}
