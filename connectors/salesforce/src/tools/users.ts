import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling, escapeSOQLLike, validateFields, isValidQueryFieldName } from '../utils.js';
import { withConnection } from '../client.js';

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    'salesforce_get_users',
    {
      description: `Get Salesforce users. Filters: name_contains, email_contains, role_contains, is_active. Max 200 (default: 50).`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Max results 1-200 (default: 50)'),
        name_contains: z.string().optional().describe('Filter by name'),
        email_contains: z.string().optional().describe('Filter by email'),
        role_contains: z.string().optional().describe('Filter by UserRole.Name'),
        is_active: z.boolean().optional().describe('Filter by active status'),
        fields: z.array(z.string()).optional().describe('Custom fields'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      return withConnection(undefined, async (conn) => {
        const defaultFields = ['Id', 'Name', 'Email', 'Username', 'IsActive', 'UserRoleId', 'Profile.Name'];
        const fields = validateFields(args.fields || [], defaultFields, isValidQueryFieldName);
        let query = `SELECT ${fields.join(', ')} FROM User`;
        const conditions: string[] = [];
        if (args.name_contains) conditions.push(`Name LIKE '%${escapeSOQLLike(args.name_contains)}%'`);
        if (args.email_contains) conditions.push(`Email LIKE '%${escapeSOQLLike(args.email_contains)}%'`);
        if (args.role_contains) conditions.push(`UserRole.Name LIKE '%${escapeSOQLLike(args.role_contains)}%'`);
        if (args.is_active !== undefined) conditions.push(`IsActive = ${args.is_active}`);
        if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
        const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
        query += ` LIMIT ${limit}`;
        const result = await conn.query(query);
        return JSON.stringify({ ok: true, records: result.records, totalSize: result.totalSize });
      });
    }),
  );
}
