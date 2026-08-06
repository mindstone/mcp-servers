/**
 * Attachment tools — workspace-constrained attachment downloads.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withErrorHandling } from '../utils.js';
import { unwrapUntrusted } from '../untrusted-content.js';
import { getConnection, getMailboxLock } from '../imap-client.js';
import { resolveDownloadDir, writeDownloadExclusive } from '../path-safety.js';
import {
  ensureInitialized,
  collectMessageParts,
  unwrapMailboxName,
  wrapEmailField,
  type MessageParts,
} from './shared.js';

/**
 * Hard cap on a single attachment download. Unbounded MIME-part downloads
 * would let a hostile (or merely huge) message exhaust disk/memory; 50 MB
 * covers legitimate document/attachment workflows.
 */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export function registerAttachmentTools(server: McpServer): void {
  // ── email_get_attachment ────────────────────────────────────────

  server.registerTool(
    'email_get_attachment',
    {
      description:
        'Download an email attachment to the local workspace. Pass the `part` value from the ' +
        'attachment metadata returned by email_get_message. The file is written inside a fresh ' +
        'private `email-imap-attachment-*` staging directory created under the workspace ' +
        'directory (MCP_WORKSPACE_PATH, or the system temp directory when unset), and the ' +
        'returned `path` points there; filenames are sanitized to a basename. Attachments ' +
        'larger than 50 MB are refused.',
      inputSchema: z.object({
        mailbox: z.string().min(1).describe('Mailbox/folder name that contains the message'),
        uid: z.number().int().positive().describe('Message UID from email_search_messages'),
        part: z
          .string()
          .min(1)
          .describe('MIME part identifier from the attachment metadata in email_get_message'),
        filename: z
          .string()
          .optional()
          .describe(
            'Optional save-as filename (basename only; directory components are stripped). ' +
              'Defaults to the attachment filename from the message.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      ensureInitialized();

      const { mailbox: rawMailbox, uid } = args;
      const mailbox = unwrapMailboxName(rawMailbox, 'mailbox');
      // `part` round-trips from email_get_message's attachment metadata,
      // where it is enveloped as server-supplied text — strip one envelope
      // layer so wrapped and manually-authored identifiers both work.
      const part = unwrapUntrusted(args.part);

      const lock = await getMailboxLock(mailbox);
      try {
        const client = await getConnection();
        const fetchedMessage = await client.fetchOne(
          uid,
          { bodyStructure: true, uid: true },
          { uid: true },
        );

        if (!fetchedMessage) {
          throw new Error('Message not found for the specified UID');
        }

        const parts: MessageParts = { attachments: [] };
        collectMessageParts(fetchedMessage.bodyStructure, parts);
        const attachment = parts.attachments.find((entry) => entry.part === part);
        if (!attachment) {
          const available = parts.attachments.map((entry) => entry.part);
          throw new Error(
            available.length > 0
              ? `No attachment part "${part}" on message ${uid}. Available attachment parts: ${available.join(', ')}.`
              : `Message ${uid} has no attachments.`,
          );
        }

        const partData = await client.download(uid, part, { uid: true });
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of partData.content) {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
          totalBytes += buffer.length;
          if (totalBytes > MAX_ATTACHMENT_BYTES) {
            throw new Error(
              `Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte download cap; refusing to save.`,
            );
          }
          chunks.push(buffer);
        }

        // Staged exclusive-create write: the download lands in a fresh,
        // unpredictable staging directory under the canonical root, so no
        // planted entry or parent-directory swap can redirect or overwrite it.
        const downloadDir = await resolveDownloadDir();
        const targetPath = await writeDownloadExclusive(
          downloadDir,
          args.filename ?? attachment.filename ?? 'attachment',
          Buffer.concat(chunks),
        );

        return JSON.stringify({
          ok: true,
          uid,
          part,
          contentType: wrapEmailField(attachment.contentType),
          sizeBytes: totalBytes,
          path: targetPath,
        });
      } finally {
        lock.release();
      }
    }),
  );
}
