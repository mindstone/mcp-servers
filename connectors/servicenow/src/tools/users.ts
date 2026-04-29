import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { servicenowFetch, buildQueryParams } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerUserTools(server: McpServer): void {
  // ── list_servicenow_users ─────────────────────────────────────

  server.registerTool(
    'list_servicenow_users',
    {
      description:
        'List or search users in ServiceNow. ' +
        'Returns: sys_id, user_name, first_name, last_name, email, title, department, active. ' +
        'user_name is the login username, not the display name. ' +
        'For name searches, use first_nameLIKE or last_nameLIKE in the query.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('ServiceNow encoded query (e.g., "active=true^departmentLIKEengineering")'),
        limit: z
          .number()
          .optional()
          .default(20)
          .describe('Max results to return (default: 20)'),
        offset: z
          .number()
          .optional()
          .default(0)
          .describe('Offset for pagination (default: 0)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const params = buildQueryParams({
        sysparm_limit: args.limit ?? 20,
        sysparm_offset: args.offset ?? 0,
        sysparm_display_value: 'true',
        sysparm_fields:
          'sys_id,user_name,first_name,last_name,email,title,department,active',
        sysparm_query: args.query,
      });
      const users = await servicenowFetch<Array<Record<string, unknown>>>(
        `/sys_user${params}`,
      );
      return JSON.stringify({ ok: true, users, count: users.length });
    }),
  );
}
