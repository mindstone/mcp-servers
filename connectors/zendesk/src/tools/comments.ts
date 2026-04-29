import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZendeskUser } from '../types.js';
import { MAX_COMMENTS_PER_TICKET } from '../types.js';
import { getAccount } from '../auth.js';
import { zendeskFetch, fetchAllTicketComments, noAccountError } from '../client.js';
import { withErrorHandling } from '../utils.js';

export function registerCommentTools(server: McpServer): void {
  server.registerTool(
    'list_zendesk_ticket_comments',
    {
      description: `List all comments/replies on a ticket.

Returns the conversation thread including public replies and internal notes.
Includes author ID, timestamp, and whether comment is public.
Automatically paginates to fetch all comments (Zendesk returns max 100 per page).`,
      inputSchema: {
        ticket_id: z.number().describe('Ticket ID'),
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
        max_comments: z.number().optional().describe('Maximum number of comments to fetch (default: 500). Use to limit results for very long threads.'),
        response_format: z.enum(['concise', 'detailed']).optional().describe('Response format (default: concise)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const account = await getAccount(args.subdomain);
      if (!account) return noAccountError();

      if (!args.ticket_id) {
        return JSON.stringify({ ok: false, error: 'ticket_id is required' });
      }

      const maxComments = args.max_comments || undefined;
      const { comments: allComments, truncated: commentsTruncated } = await fetchAllTicketComments(
        account,
        args.ticket_id,
        maxComments ? { maxComments } : undefined
      );

      const authorIds = [...new Set(
        allComments
          .map(c => c.author_id)
          .filter((id): id is number => typeof id === 'number' && id > 0)
      )];
      const authorMap = new Map<number, string>();

      if (authorIds.length > 0) {
        try {
          const usersResponse = await zendeskFetch<{ users: ZendeskUser[] }>(
            account,
            `/users/show_many.json`,
            { params: { ids: authorIds.join(',') } }
          );
          for (const user of usersResponse.users) {
            authorMap.set(user.id, user.name);
          }
        } catch {
          // If batch fetch fails, continue with IDs only
        }
      }

      const format = args.response_format || 'concise';
      if (format === 'concise') {
        const lines = allComments.map(c => {
          const visibility = c.public ? 'Public' : 'Internal';
          const preview = c.body.slice(0, 150) + (c.body.length > 150 ? '...' : '');
          const authorName = authorMap.get(c.author_id) || `User ${c.author_id}`;
          return `[${c.created_at}] ${visibility} - ${authorName}:\n${preview}`;
        });
        let result = `Comments on ticket #${args.ticket_id} (${allComments.length}):\n\n${lines.join('\n\n')}`;
        if (commentsTruncated) {
          result += `\n\n[TRUNCATED: More comments exist but were limited to ${maxComments ?? MAX_COMMENTS_PER_TICKET}]`;
        }
        return result;
      }

      const commentsWithAuthors = allComments.map(c => ({
        ...c,
        author_name: authorMap.get(c.author_id) || null,
      }));
      return JSON.stringify({ ok: true, comments: commentsWithAuthors, count: allComments.length, truncated: commentsTruncated });
    }),
  );

  server.registerTool(
    'add_zendesk_ticket_comment',
    {
      description: `Add a comment to a ticket.

Can be a public reply (visible to requester) or internal note (agents only).
Default is public comment.`,
      inputSchema: {
        ticket_id: z.number().describe('Ticket ID'),
        body: z.string().describe('Comment text'),
        subdomain: z.string().optional().describe('Zendesk subdomain (optional if only one account connected)'),
        public: z.boolean().optional().describe('Public reply (true) or internal note (false)? Default: true'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const account = await getAccount(args.subdomain);
      if (!account) return noAccountError();

      if (!args.ticket_id || !args.body) {
        return JSON.stringify({ ok: false, error: 'ticket_id and body are required' });
      }

      const payload = {
        ticket: {
          comment: {
            body: args.body,
            public: args.public !== false,
          },
        },
      };

      await zendeskFetch(account, `/tickets/${args.ticket_id}.json`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });

      const visibility = args.public !== false ? 'public comment' : 'internal note';
      return JSON.stringify({ ok: true, message: `Added ${visibility} to ticket #${args.ticket_id}` });
    }),
  );
}
