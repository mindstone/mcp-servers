import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZendeskGroup, ZendeskTicketField, ZendeskView, ZendeskOrganization } from '../types.js';
import { getAccount } from '../auth.js';
import { zendeskFetch, noAccountError } from '../client.js';
import { formatGroup, formatTicketField } from '../formatters.js';
import { withErrorHandling } from '../utils.js';

export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool(
    'list_zendesk_groups',
    {
      description: `List all agent groups in Zendesk.

Returns groups with their IDs and names. Use group IDs when:
- Creating tickets with a specific group assignment
- Updating ticket group_id
- Filtering tickets by group

Example: "Engineering Support" → ID: 360001234567`,
      inputSchema: {
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
        response_format: z.enum(['concise', 'detailed']).optional().describe('Response format: "concise" (default) for names+IDs, "detailed" for full metadata'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const account = await getAccount(args.subdomain);
      if (!account) return noAccountError();

      const response = await zendeskFetch<{ groups: ZendeskGroup[] }>(account, '/groups.json');
      const format = args.response_format || 'concise';
      if (format === 'concise') {
        const lines = response.groups.map(formatGroup);
        return `Groups (${response.groups.length}):\n${lines.join('\n')}`;
      }
      return JSON.stringify({ ok: true, groups: response.groups, count: response.groups.length });
    }),
  );

  server.registerTool(
    'list_zendesk_ticket_fields',
    {
      description: `List all ticket fields including custom fields.

Returns field IDs, titles, types, and options. Essential for:
- Finding custom field IDs for create/update operations
- Discovering dropdown options for custom fields
- Understanding required fields

Custom fields use numeric IDs (e.g., 360001234567) not names.`,
      inputSchema: {
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
        active_only: z.boolean().optional().describe('Only return active fields (default: true)'),
        response_format: z.enum(['concise', 'detailed']).optional().describe('Response format: "concise" (default) for title+ID+type, "detailed" for full metadata including options'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const account = await getAccount(args.subdomain);
      if (!account) return noAccountError();

      const response = await zendeskFetch<{ ticket_fields: ZendeskTicketField[] }>(account, '/ticket_fields.json');
      let fields = response.ticket_fields;
      const activeOnly = args.active_only !== false;
      if (activeOnly) {
        fields = fields.filter(f => f.active);
      }
      const format = args.response_format || 'concise';
      if (format === 'concise') {
        const lines = fields.map(formatTicketField);
        return `Ticket Fields (${fields.length}):\n${lines.join('\n')}`;
      }
      return JSON.stringify({ ok: true, ticket_fields: fields, count: fields.length });
    }),
  );

  server.registerTool(
    'list_zendesk_views',
    {
      description: `List available ticket views in Zendesk.

Views are saved searches/filters that organize tickets. Returns:
- View ID, title, and active status
- Whether the view is shared or personal

Use views to efficiently find tickets by pre-defined criteria like
"My open tickets", "Unassigned tickets", "High priority queue".`,
      inputSchema: {
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
        active_only: z.boolean().optional().describe('Only return active views (default: true)'),
        response_format: z.enum(['concise', 'detailed']).optional().describe('Response format (default: concise)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const account = await getAccount(args.subdomain);
      if (!account) return noAccountError();

      const response = await zendeskFetch<{ views: ZendeskView[] }>(account, '/views.json');
      let views = response.views;
      const activeOnly = args.active_only !== false;
      if (activeOnly) {
        views = views.filter(v => v.active);
      }
      const format = args.response_format || 'concise';
      if (format === 'concise') {
        const lines = views.map(v => {
          const visibility = !v.restriction ? 'Shared'
            : v.restriction.type === 'User' ? 'Personal'
            : v.restriction.type === 'Group' ? 'Group'
            : 'Restricted';
          return `${v.title} (ID: ${v.id}, ${visibility})`;
        });
        return `Views (${views.length}):\n${lines.join('\n')}`;
      }
      return JSON.stringify({ ok: true, views, count: views.length });
    }),
  );

  server.registerTool(
    'list_zendesk_organizations',
    {
      description: `List organizations in Zendesk.

Organizations group end-users (customers) together, typically by company.
Returns organization ID, name, and domain names.

Use organization IDs when:
- Filtering tickets by organization
- Creating users with an organization
- Understanding customer context`,
      inputSchema: {
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
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
        page: args.page || 1,
        per_page: Math.min(args.per_page || 25, 100),
      };
      const response = await zendeskFetch<{
        organizations: ZendeskOrganization[];
        count: number;
        next_page?: string;
      }>(account, '/organizations.json', { params });

      const format = args.response_format || 'concise';
      if (format === 'concise') {
        const lines = response.organizations.map(o => {
          const domains = o.domain_names?.length ? ` [${o.domain_names.join(', ')}]` : '';
          return `${o.name} (ID: ${o.id})${domains}`;
        });
        return `Organizations (${response.organizations.length} of ${response.count}):\n${lines.join('\n')}`;
      }
      return JSON.stringify({
        ok: true,
        organizations: response.organizations,
        count: response.organizations.length,
        total: response.count,
        hasMore: !!response.next_page,
      });
    }),
  );
}
