import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZendeskUser } from '../types.js';
import { getAccount } from '../auth.js';
import { zendeskFetch, noAccountError } from '../client.js';
import { formatUser } from '../formatters.js';
import { withErrorHandling } from '../utils.js';

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    'search_zendesk_users',
    {
      description: `Search Zendesk users by name, email, or query.

Examples:
- "john@example.com" - Find by email
- "John Smith" - Find by name
- "role:admin" - Find all admins
- "organization:Acme Corp" - Find by organization

Returns user ID, name, email, role, and organization.`,
      inputSchema: {
        query: z.string().describe('Search query (name, email, or Zendesk query syntax)'),
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
        role: z.enum(['end-user', 'agent', 'admin']).optional().describe('Filter by role'),
        page: z.number().optional().describe('Page number (default: 1)'),
        per_page: z.number().optional().describe('Results per page, max 100 (default: 25)'),
        response_format: z.enum(['concise', 'detailed']).optional().describe('Response format (default: concise)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const account = await getAccount(args.subdomain);
      if (!account) return noAccountError();

      const params: Record<string, string | number> = {
        query: `type:user ${args.query}`,
        page: args.page || 1,
        per_page: Math.min(args.per_page || 25, 100),
      };

      const response = await zendeskFetch<{
        results: ZendeskUser[];
        count: number;
        next_page?: string;
      }>(account, '/search.json', { params });

      const format = args.response_format || 'concise';
      const formatOpts = { format: format as 'concise' | 'detailed' };
      if (format === 'concise') {
        const lines = response.results.map(u => formatUser(u, formatOpts));
        return `Users (${response.results.length} of ${response.count}):\n${lines.join('\n')}`;
      }
      return JSON.stringify({
        ok: true,
        users: response.results,
        count: response.results.length,
        total: response.count,
      });
    }),
  );

  server.registerTool(
    'get_zendesk_user',
    {
      description: `Get a Zendesk user by ID.

Returns full user details including name, email, role, phone, organization, and custom fields.`,
      inputSchema: {
        user_id: z.number().describe('User ID'),
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
        response_format: z.enum(['concise', 'detailed']).optional().describe('Response format (default: detailed)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const account = await getAccount(args.subdomain);
      if (!account) return noAccountError();

      if (!args.user_id) {
        return JSON.stringify({ ok: false, error: 'user_id is required' });
      }

      const response = await zendeskFetch<{ user: ZendeskUser }>(account, `/users/${args.user_id}.json`);
      const format = args.response_format || 'detailed';
      if (format === 'concise') {
        return formatUser(response.user, { format: 'concise' });
      }
      return JSON.stringify({ ok: true, user: response.user });
    }),
  );
}
