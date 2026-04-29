/**
 * Send/draft tools — sending emails and saving drafts.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import nodemailer from 'nodemailer';
import { withErrorHandling } from '../utils.js';
import { getConnection } from '../imap-client.js';
import { getTransport } from '../smtp-client.js';
import {
  ensureInitialized,
  generateMessageId,
  resolveDraftsMailbox,
} from './shared.js';

export function registerSendTools(server: McpServer): void {
  // ── email_send ──────────────────────────────────────────────────

  server.registerTool(
    'email_send',
    {
      description:
        'Send an email. For replies, provide reply_to_message_id from the original message.',
      inputSchema: z.object({
        to: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe('Recipient email address or array of addresses'),
        subject: z.string().optional().describe('Email subject line'),
        text: z.string().optional().describe('Plain-text email body'),
        html: z.string().optional().describe('HTML email body'),
        cc: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .optional()
          .describe('CC recipient(s)'),
        bcc: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .optional()
          .describe('BCC recipient(s)'),
        reply_to_message_id: z
          .string()
          .optional()
          .describe('Message-ID of the original email when replying'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const config = ensureInitialized();

      const { to, subject, text, html, cc, bcc, reply_to_message_id } = args;
      const messageId = generateMessageId(config.email);

      const transport = await getTransport();
      await transport.sendMail({
        from: config.email,
        to,
        cc,
        bcc,
        subject,
        text,
        html,
        messageId,
        ...(reply_to_message_id
          ? {
              inReplyTo: reply_to_message_id,
              references: reply_to_message_id,
            }
          : {}),
      });

      return JSON.stringify({ ok: true, messageId });
    }),
  );

  // ── email_save_draft ────────────────────────────────────────────

  server.registerTool(
    'email_save_draft',
    {
      description: 'Save a draft email to the Drafts folder.',
      inputSchema: z.object({
        to: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .optional()
          .describe('Recipient email address or array of addresses'),
        subject: z.string().optional().describe('Draft subject line'),
        text: z.string().optional().describe('Plain-text draft body'),
        html: z.string().optional().describe('HTML draft body'),
        reply_to_message_id: z
          .string()
          .optional()
          .describe('Message-ID of the original email when drafting a reply'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const config = ensureInitialized();

      const { to, subject, text, html, reply_to_message_id } = args;

      const hasSubject = Boolean(subject && subject.trim().length > 0);
      const hasBody =
        Boolean(text && text.trim().length > 0) ||
        Boolean(html && html.trim().length > 0);
      if (!hasSubject && !hasBody) {
        throw new Error('Provide at least a subject or a text/html body');
      }

      const messageId = generateMessageId(config.email);
      const draftTransport = nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: 'unix',
      });

      const draftResult = await draftTransport.sendMail({
        from: config.email,
        to,
        subject,
        text,
        html,
        messageId,
        ...(reply_to_message_id
          ? {
              inReplyTo: reply_to_message_id,
              references: reply_to_message_id,
            }
          : {}),
      });
      draftTransport.close();

      const rawMessageValue = (draftResult as { message?: unknown }).message;
      const rawMessage = Buffer.isBuffer(rawMessageValue)
        ? rawMessageValue
        : typeof rawMessageValue === 'string'
          ? Buffer.from(rawMessageValue)
          : null;
      if (!rawMessage) {
        throw new Error('Unable to construct raw draft message');
      }

      const draftsMailbox = await resolveDraftsMailbox();
      const client = await getConnection();
      const appendResult = await client.append(draftsMailbox, rawMessage, [
        '\\Draft',
        '\\Seen',
      ]);

      if (!appendResult) {
        throw new Error('Unable to append draft message');
      }

      return JSON.stringify({
        ok: true,
        messageId,
        mailbox: draftsMailbox,
        ...(appendResult.uid !== undefined ? { uid: appendResult.uid } : {}),
      });
    }),
  );
}
