import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import { outreachFetch, formatResources, clampLimit } from '../client.js';

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    'outreach_list_users',
    {
      description: `List Outreach team members. Example: {}

Returns users with name, email, and role information.`,
      inputSchema: z.object({
        limit: z.number().min(1).max(50).default(25).optional().describe('Max results (default 25, max 50)'),
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
      const params: Record<string, string> = { 'page[size]': String(limit) };
      const response = await outreachFetch('/users', { params });
      const records = formatResources(response.data);
      return JSON.stringify({
        ok: true,
        records,
        // The API may omit meta.count; fall back to the number of records
        // actually returned rather than reporting a misleading 0.
        count: response.meta?.count ?? records.length,
      });
    }),
  );
}
