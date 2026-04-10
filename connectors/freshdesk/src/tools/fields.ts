import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAccount } from '../auth.js';
import { freshdeskFetch } from '../client.js';
import type { FreshdeskTicketField } from '../types.js';
import { formatTicketField } from '../formatters.js';
import { withErrorHandling } from '../utils.js';

export function registerFieldTools(server: McpServer): void {
  server.registerTool(
    'list_freshdesk_ticket_fields',
    {
      description:
        'List all ticket fields including custom fields. Returns field IDs, names, types, and options. ' +
        'Essential for finding custom field names for create/update operations.',
      inputSchema: z.object({
        domain: z.string().optional().describe('Freshdesk domain (optional if only one account)'),
        response_format: z
          .enum(['concise', 'detailed'])
          .optional()
          .describe('Response format (default: "concise")'),
      }),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async (args) => {
      const account = getAccount(args.domain);
      if (!account) {
        return JSON.stringify({
          ok: false,
          error: 'No Freshdesk account connected',
          resolution:
            'Use configure_freshdesk to connect your account.',
        });
      }

      const fields = await freshdeskFetch<FreshdeskTicketField[]>(
        account.domain,
        account.apiKey,
        '/admin/ticket_fields',
      );

      const format = args.response_format || 'concise';

      if (format === 'concise') {
        const lines = fields.map(formatTicketField);
        return `Ticket Fields (${fields.length}):\n${lines.join('\n')}`;
      }

      return JSON.stringify({
        ok: true,
        ticket_fields: fields,
        count: fields.length,
      });
    }),
  );
}
