import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import {
  outreachFetch,
  formatResources,
  clampLimit,
  paginationParams,
} from '../client.js';

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    'outreach_list_tasks',
    {
      description: `List Outreach tasks. Example: { "status": "incomplete" } or { "prospect_id": "123" }

Returns tasks with status, due date, type, and assigned user.`,
      inputSchema: z.object({
        status: z
          .enum(['incomplete', 'complete'])
          .optional()
          .describe('Filter by completion status'),
        prospect_id: z.string().optional().describe('Filter tasks for a specific prospect'),
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
      if (args.status) params['filter[status]'] = args.status;
      if (args.prospect_id) params['filter[prospect][id]'] = args.prospect_id;

      const response = await outreachFetch('/tasks', { params });
      return JSON.stringify({
        ok: true,
        records: formatResources(response.data),
        count: response.meta?.count ?? 0,
        page: response.meta?.page,
      });
    }),
  );
}
