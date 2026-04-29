import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZendeskMacro, ZendeskMacroApplyResult, ZendeskTicket } from '../types.js';
import { getAccount } from '../auth.js';
import { zendeskFetch, noAccountError } from '../client.js';
import { formatMacro } from '../formatters.js';
import { withErrorHandling } from '../utils.js';

export function registerMacroTools(server: McpServer): void {
  server.registerTool(
    'list_zendesk_macros',
    {
      description: `List or search Zendesk macros.

Macros are predefined sets of actions that agents can apply to tickets with one click.
Actions can set ticket fields (status, priority, assignee, group), add comments, or modify tags.

When query is provided, searches macros by title. Otherwise lists all macros.
Use get_zendesk_macro to see the full actions for a specific macro.
Use apply_zendesk_macro to apply a macro to a ticket.`,
      inputSchema: {
        query: z.string().optional().describe('Search query to filter macros by title (uses /macros/search endpoint). Omit to list all macros.'),
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
        active: z.boolean().optional().describe('Filter by active macros (default: all)'),
        page: z.number().optional().describe('Page number (default: 1)'),
        per_page: z.number().optional().describe('Results per page, max 100 (default: 100)'),
        response_format: z.enum(['concise', 'detailed']).optional().describe('Response format: "concise" (default) for title+ID, "detailed" for full macro data including actions'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const account = await getAccount(args.subdomain);
      if (!account) return noAccountError();

      const perPage = Math.min(args.per_page || 100, 100);
      const page = args.page || 1;

      let macros: ZendeskMacro[];
      let totalCount: number;
      let hasMore: boolean;

      if (args.query) {
        const response = await zendeskFetch<{
          results: ZendeskMacro[];
          count: number;
          next_page: string | null;
        }>(account, '/macros/search.json', {
          params: { query: args.query, page, per_page: perPage },
        });
        macros = response.results;
        totalCount = response.count;
        hasMore = !!response.next_page;
      } else {
        const params: Record<string, string | number | boolean | undefined> = {
          page,
          per_page: perPage,
        };
        if (args.active !== undefined) {
          params.active = args.active;
        }
        const response = await zendeskFetch<{
          macros: ZendeskMacro[];
          count: number;
          next_page: string | null;
        }>(account, '/macros.json', { params });
        macros = response.macros;
        totalCount = response.count;
        hasMore = !!response.next_page;
      }

      const format = args.response_format || 'concise';
      const formatOpts = { format: format as 'concise' | 'detailed' };
      if (format === 'concise') {
        const lines = macros.map(m => formatMacro(m, formatOpts));
        return `Macros (${macros.length} of ${totalCount})${hasMore ? ' - more available' : ''}:\n${lines.join('\n')}`;
      }
      return JSON.stringify({ ok: true, macros, count: macros.length, total: totalCount, hasMore });
    }),
  );

  server.registerTool(
    'get_zendesk_macro',
    {
      description: `Get a single Zendesk macro by ID.

Returns macro details including title, description, and the list of actions it performs.
Actions use { field, value } format where field is e.g. "status", "priority", "assignee_id",
"group_id", "comment_value", "current_tags", etc.

Use list_zendesk_macros to find macro IDs.`,
      inputSchema: {
        macro_id: z.number().describe('Macro ID'),
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
        response_format: z.enum(['concise', 'detailed']).optional().describe('Response format (default: detailed)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const account = await getAccount(args.subdomain);
      if (!account) return noAccountError();

      if (!args.macro_id) {
        return JSON.stringify({
          ok: false,
          error: 'macro_id is required',
          resolution: 'Provide the numeric ID of the macro. Use list_zendesk_macros to find macro IDs.',
        });
      }

      const response = await zendeskFetch<{ macro: ZendeskMacro }>(account, `/macros/${args.macro_id}.json`);
      const format = args.response_format || 'detailed';
      if (format === 'concise') {
        return formatMacro(response.macro, { format: 'concise' });
      }
      return JSON.stringify({ ok: true, macro: response.macro });
    }),
  );

  server.registerTool(
    'apply_zendesk_macro',
    {
      description: `Preview and apply a Zendesk macro to a ticket.

First previews what changes the macro would make, then applies them.
Set preview_only=true to see the changes without applying.
This tool makes 2 API calls: one to preview, one to apply.

The preview shows the resulting ticket state after macro application.
When applied, the macro's actions (set status, add comment, change assignee, etc.) are executed on the ticket.

Example:
{
  "ticket_id": 12345,
  "macro_id": 67890
}`,
      inputSchema: {
        ticket_id: z.number().describe('Ticket ID to apply the macro to'),
        macro_id: z.number().describe('Macro ID to apply'),
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
        preview_only: z.boolean().optional().describe('If true, only preview the changes without applying (default: false)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const account = await getAccount(args.subdomain);
      if (!account) return noAccountError();

      if (!args.ticket_id || !args.macro_id) {
        return JSON.stringify({
          ok: false,
          error: 'ticket_id and macro_id are required',
          resolution: 'Provide both the ticket ID and the macro ID. Use list_zendesk_macros to find macro IDs.',
        });
      }

      const preview = await zendeskFetch<ZendeskMacroApplyResult>(
        account,
        `/tickets/${args.ticket_id}/macros/${args.macro_id}/apply.json`
      );
      const previewTicket = preview.result.ticket;

      if (args.preview_only === true) {
        return JSON.stringify({
          ok: true,
          preview: true,
          message: `Preview of macro ${args.macro_id} on ticket #${args.ticket_id} (not applied)`,
          changes: previewTicket,
        });
      }

      const readOnlyFields = new Set([
        'id', 'url', 'created_at', 'updated_at', 'requester_id', 'via',
        'satisfaction_rating', 'sharing_agreement_ids', 'followup_ids',
        'ticket_id', 'result_type',
      ]);

      const ticketUpdate: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(previewTicket)) {
        if (!readOnlyFields.has(key) && value !== undefined) {
          ticketUpdate[key] = value;
        }
      }

      if (ticketUpdate.comment && typeof ticketUpdate.comment === 'object') {
        const { scoped_body, ...cleanComment } = ticketUpdate.comment as Record<string, unknown>;
        ticketUpdate.comment = cleanComment;
      }

      const updateResponse = await zendeskFetch<{ ticket: ZendeskTicket }>(
        account,
        `/tickets/${args.ticket_id}.json`,
        { method: 'PUT', body: JSON.stringify({ ticket: ticketUpdate }) }
      );

      const appliedFields = Object.keys(ticketUpdate);
      const hasComment = 'comment' in ticketUpdate;

      return JSON.stringify({
        ok: true,
        message: `Macro ${args.macro_id} applied to ticket #${args.ticket_id}`,
        applied_fields: appliedFields,
        comment_added: hasComment,
        ticket: {
          id: updateResponse.ticket.id,
          subject: updateResponse.ticket.subject,
          status: updateResponse.ticket.status,
          priority: updateResponse.ticket.priority,
        },
      });
    }),
  );
}
