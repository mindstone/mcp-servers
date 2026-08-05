import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZendeskUser } from '../types.js';
import { getAccount } from '../auth.js';
import { zendeskFetch, noAccountError } from '../client.js';
import { formatUser, wrapUserFields } from '../formatters.js';
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
        page: z.number().int().min(1).optional().describe('Page number (default: 1)'),
        per_page: z.number().int().min(1).max(100).optional().describe('Results per page, max 100 (default: 25)'),
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
      // User names and emails are end-user-authored — wrap them before they
      // reach the host LLM.
      const wrappedUsers = response.results.map(u => wrapUserFields(u));
      if (format === 'concise') {
        const lines = wrappedUsers.map(u => formatUser(u, formatOpts));
        return `Users (${wrappedUsers.length} of ${response.count}):\n${lines.join('\n')}`;
      }
      return JSON.stringify({
        ok: true,
        users: wrappedUsers,
        count: wrappedUsers.length,
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
        user_id: z.number().int().positive().describe('User ID'),
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
      const user = wrapUserFields(response.user);
      const format = args.response_format || 'detailed';
      if (format === 'concise') {
        return formatUser(user, { format: 'concise' });
      }
      return JSON.stringify({ ok: true, user });
    }),
  );

  server.registerTool(
    'create_or_update_zendesk_user',
    {
      description: `Create a Zendesk user, or update the existing user with the same email.

Uses the Zendesk create_or_update endpoint: if a user with the given email
already exists, that user is updated; otherwise a new user is created.
Useful for adding a new customer contact before filing tickets on their
behalf.

Use search_zendesk_users first if you only need to check whether the user exists.

Example:
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "organization_id": 500
}`,
      inputSchema: {
        name: z.string().min(1).describe('Full name of the user'),
        email: z.string().email().describe('Email address — the identity key for create-or-update'),
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
        phone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Phone number must be in E.164 format (e.g. "+14155552671")').optional().describe('Phone number in E.164 format'),
        organization_id: z.number().int().positive().optional().describe('Organization ID (use list_zendesk_organizations to find)'),
        role: z.enum(['end-user', 'agent', 'admin']).optional().describe('User role (Zendesk defaults to end-user when omitted)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const account = await getAccount(args.subdomain);
      if (!account) return noAccountError();

      if (!args.name || !args.email) {
        return JSON.stringify({ ok: false, error: 'name and email are required' });
      }

      const user: Record<string, unknown> = {
        name: args.name,
        email: args.email,
        ...(args.phone ? { phone: args.phone } : {}),
        ...(args.organization_id ? { organization_id: args.organization_id } : {}),
        ...(args.role ? { role: args.role } : {}),
      };

      const response = await zendeskFetch<{ user: ZendeskUser }>(account, '/users/create_or_update.json', {
        method: 'POST',
        body: JSON.stringify({ user }),
      });

      const wrappedUser = wrapUserFields(response.user);
      return JSON.stringify({
        ok: true,
        message: `User ${response.user.id} created or updated`,
        user: {
          id: response.user.id,
          name: wrappedUser.name,
          email: wrappedUser.email,
          role: response.user.role,
          organization_id: response.user.organization_id,
        },
      });
    }),
  );
}
