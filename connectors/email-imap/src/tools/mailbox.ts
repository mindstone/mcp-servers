/**
 * Mailbox tools — listing mailboxes and getting mailbox status.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withErrorHandling } from '../utils.js';
import { getConnection } from '../imap-client.js';
import { getMailboxLock } from '../imap-client.js';
import { ensureInitialized, formatAddresses, formatDate } from './shared.js';

export function registerMailboxTools(server: McpServer): void {
  // ── email_list_mailboxes ────────────────────────────────────────

  server.registerTool(
    'email_list_mailboxes',
    {
      description: 'List all email folders/mailboxes with message counts.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async () => {
      ensureInitialized();

      const client = await getConnection();
      const listedMailboxes = await client.list({
        statusQuery: {
          messages: true,
          unseen: true,
        },
      });

      const mailboxes = await Promise.all(
        listedMailboxes.map(async (mailbox) => {
          let messages = mailbox.status?.messages;
          let unseen = mailbox.status?.unseen;

          if (messages === undefined || unseen === undefined) {
            const status = await client.status(mailbox.path, {
              messages: true,
              unseen: true,
            });
            messages = status.messages ?? 0;
            unseen = status.unseen ?? 0;
          }

          return {
            name: mailbox.path,
            specialUse:
              mailbox.specialUse ??
              (mailbox.path.toUpperCase() === 'INBOX' ? '\\Inbox' : undefined),
            messages,
            unseen,
          };
        }),
      );

      return JSON.stringify({ ok: true, mailboxes });
    }),
  );

  // ── email_get_mailbox_status ────────────────────────────────────

  server.registerTool(
    'email_get_mailbox_status',
    {
      description:
        'Get mailbox status: total count, unread count, and optionally the latest unread message subjects.',
      inputSchema: z.object({
        mailbox: z.string().optional().describe('Mailbox/folder name (defaults to INBOX)'),
        includeLatest: z
          .boolean()
          .optional()
          .describe('Include latest unread message summaries'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      ensureInitialized();

      const mailbox = args.mailbox?.trim() || 'INBOX';
      const includeLatest = args.includeLatest ?? false;
      const client = await getConnection();

      const status = await client.status(mailbox, {
        messages: true,
        unseen: true,
      });

      let latestUnread:
        | Array<{ uid: number; subject: string; from: string; date: string | null }>
        | undefined;

      if (includeLatest) {
        const lock = await getMailboxLock(mailbox);
        try {
          const unreadUidsResult = await client.search({ seen: false }, { uid: true });
          const unreadUids = Array.isArray(unreadUidsResult) ? unreadUidsResult : [];
          const latestUids = [...unreadUids].sort((a, b) => b - a).slice(0, 5);

          latestUnread = [];
          if (latestUids.length > 0) {
            for await (const message of client.fetch(
              latestUids,
              {
                uid: true,
                envelope: true,
              },
              { uid: true },
            )) {
              latestUnread.push({
                uid: message.uid,
                subject: message.envelope?.subject ?? '',
                from: formatAddresses(message.envelope?.from),
                date: formatDate(message.envelope?.date),
              });
            }
          }

          latestUnread.sort((a, b) => b.uid - a.uid);
        } finally {
          lock.release();
        }
      }

      return JSON.stringify({
        ok: true,
        mailbox,
        total: status.messages ?? 0,
        unread: status.unseen ?? 0,
        ...(latestUnread ? { latestUnread } : {}),
      });
    }),
  );
}
