import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import {
  outreachFetch,
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
        user_id: z.string().optional().describe('Filter mailboxes owned by a specific Outreach user'),
        limit: z.number().min(1).max(50).default(25).optional().describe('Max results (default 25, max 50)'),
        page_offset: z.number().min(0).optional().describe('Page offset for pagination'),
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
      return JSON.stringify({
        ok: true,
        records: formatResources(response.data),
        count: response.meta?.count ?? 0,
        page: response.meta?.page,
      });
    }),
  );
}
