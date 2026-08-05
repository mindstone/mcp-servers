import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import {
  outreachFetch,
  formatResources,
  clampLimit,
  paginationParams,
} from '../client.js';

export function registerMailingTools(server: McpServer): void {
  server.registerTool(
    'outreach_list_mailings',
    {
      description: `List recent mailings (sent emails). Example: { "prospect_id": "123" } or { "limit": 10 }

Returns sent emails with subject, status (delivered/bounced/opened), and timestamps.`,
      inputSchema: z.object({
        prospect_id: z.string().optional().describe('Filter mailings for a specific prospect'),
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

      const response = await outreachFetch('/mailings', { params });
      return JSON.stringify({
        ok: true,
        records: formatResources(response.data),
        count: response.meta?.count ?? 0,
        page: response.meta?.page,
      });
    }),
  );
}
