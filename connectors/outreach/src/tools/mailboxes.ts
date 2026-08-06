import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import {
  outreachFetch,
  outreachIdSchema,
  formatResources,
  clampLimit,
  paginationParams,
} from '../client.js';

export function registerMailboxTools(server: McpServer): void {
  server.registerTool(
    'outreach_list_mailboxes',
    {
      description: `List Outreach mailboxes (connected sender email accounts). Example: {}

Returns mailboxes with email address, send/sync status, and owning user.
WORKFLOW: Use the returned IDs as mailbox_id when enrolling a prospect with
outreach_add_prospect_to_sequence.`,
      inputSchema: z.object({
        user_id: outreachIdSchema.optional().describe('Filter mailboxes owned by a specific Outreach user'),
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
      if (args.user_id) params['filter[user][id]'] = args.user_id;

      const response = await outreachFetch('/mailboxes', { params });
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
