/**
 * QuickBooks employee tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import { qboQuery } from '../client.js';
import { sanitizeQboEntity } from '../sanitize.js';

export function registerEmployeeTools(server: McpServer): void {
  server.registerTool(
    'list_quickbooks_employees',
    {
      description: `List employees from QuickBooks Online.

Returns: Id, DisplayName, PrimaryEmailAddr, PrimaryPhone, Active.

Example: {}`,
      inputSchema: z.object({
        active: z.boolean().optional().describe('Filter by active status'),
        limit: z.number().optional().describe('Max results (default: 50)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const limit = Math.min(args.limit ?? 50, 1000);

      let where = '';
      if (args.active !== undefined) where = ` WHERE Active = ${args.active}`;

      const query = `SELECT * FROM Employee${where} ORDERBY DisplayName`;
      const employees = await qboQuery('Employee', query, limit);
      return JSON.stringify({
        ok: true,
        employees: sanitizeQboEntity(employees, 'quickbooks:list_quickbooks_employees'),
        count: employees.length,
      });
    }),
  );
}
