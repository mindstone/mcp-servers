import { fileReadContext, type FileReadContext } from '../file-read-context.js';
/**
 * Send/draft tools — sending emails and saving drafts.
 *
 * `email_send` is annotated `destructiveHint: true, openWorldHint: true`; the
 * host decides whether to ask before each send.
 */

import { z } from 'zod';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import nodemailer from 'nodemailer';
import { withErrorHandling } from '../utils.js';
import { getConnection } from '../imap-client.js';
import { getTransport } from '../smtp-client.js';
import { readWorkspaceAttachment, sanitizeAttachmentFilename } from '../path-safety.js';
import {
  ensureInitialized,
  generateMessageId,
  resolveDraftsMailbox,
  wrapEmailField,
} from './shared.js';

/**
 * Blast-radius caps for outbound attachments: at most 10 files and 25 MB
 * total per message (25 MB matches common SMTP message-size limits).
 */
const MAX_OUTBOUND_ATTACHMENTS = 10;
const MAX_OUTBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const outboundAttachmentSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Path to an attachment file. When connected to a host that authorizes file reads, ' +
        'its path permission decision applies. Standalone clients require the file inside ' +
        'the workspace sandbox (MCP_WORKSPACE_PATH, or the system temp directory when unset).',
    ),
  filename: z
    .string()
    .optional()
    .describe('Optional display filename for the attachment (basename only)'),
});

export const attachmentsSchema = z
  .array(outboundAttachmentSchema)
  .max(MAX_OUTBOUND_ATTACHMENTS)
  .optional()
  .describe(`Files to attach (max ${MAX_OUTBOUND_ATTACHMENTS}, 25 MB total across all files)`);

export type OutboundAttachment = z.infer<typeof outboundAttachmentSchema>;

/**
 * A resolved outbound attachment: bytes read through a single validated file
 * descriptor (see readWorkspaceAttachment) plus the display filename.
 * Nodemailer receives `content` (never a `path`) so it cannot re-open a
 * swapped file after validation.
 */
export interface ResolvedOutboundAttachment {
  content: Buffer;
  filename: string;
}

/**
 * Read outbound attachments from canonical in-workspace files (open-once,
 * fstat, read-through-fd) and enforce the aggregate size cap against the
 * descriptor's size. Each file's size is checked against the REMAINING
 * budget before its bytes are read, so an oversized file is refused without
 * being buffered first. Throws before any network I/O when a path escapes
 * the sandbox or the cap is exceeded.
 */
function resolveOutboundAttachments(
  attachments: OutboundAttachment[] | undefined,
  context?: FileReadContext,
): ResolvedOutboundAttachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  const resolved: ResolvedOutboundAttachment[] = [];
  let totalBytes = 0;
  for (const [index, attachment] of attachments.entries()) {
    const read = readWorkspaceAttachment(
      attachment.path,
      MAX_OUTBOUND_ATTACHMENT_BYTES - totalBytes,
      context,
      ['attachments', index, 'path'],
    );
    totalBytes += read.sizeBytes;
    if (totalBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments exceed the ${MAX_OUTBOUND_ATTACHMENT_BYTES}-byte aggregate cap; ` +
          'remove files or send them in separate messages.',
      );
    }
    resolved.push({
      content: read.content,
      filename: attachment.filename
        ? sanitizeAttachmentFilename(attachment.filename)
        : path.basename(read.canonicalPath),
    });
  }
  return resolved;
}

/**
 * Draft field payload shared by email_save_draft and email_update_draft.
 */
export interface DraftFields {
  to?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  reply_to_message_id?: string;
  attachments?: OutboundAttachment[];
}

/**
 * Build a raw RFC822 draft message and append it to the account's Drafts
 * mailbox with \Draft \Seen flags. Returns the new draft's Message-ID,
 * mailbox, and (when the server reports it) UID.
 */
export async function appendDraftMessage(
  fromEmail: string,
  fields: DraftFields,
  context?: FileReadContext,
): Promise<{ messageId: string; mailbox: string; uid?: number }> {
  const { to, subject, text, html, reply_to_message_id } = fields;

  const messageId = generateMessageId(fromEmail);
  const draftTransport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });

  const draftResult = await draftTransport.sendMail({
    from: fromEmail,
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
    ...(fields.attachments
      ? { attachments: resolveOutboundAttachments(fields.attachments, context) }
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

  return {
    messageId,
    mailbox: draftsMailbox,
    ...(appendResult.uid !== undefined ? { uid: appendResult.uid } : {}),
  };
}

export function registerSendTools(server: McpServer): void {
  // ── email_send ──────────────────────────────────────────────────

  server.registerTool(
    'email_send',
    {
      description:
        'Send an email. For replies, provide reply_to_message_id from the original message. ' +
        'Attachments (max 10, 25 MB total) use the path permission decision of a connected host ' +
        'that authorizes file reads. Standalone clients require attachment files inside the ' +
        'workspace sandbox (MCP_WORKSPACE_PATH, or the system temp directory when unset).',
      _meta: { 'files/readInputs': { version: 1, inputs: [{ selector: ['attachments', '*', 'path'], base: 'connectorCwd', expandTilde: true }] } },
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
        attachments: attachmentsSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args, extra) => {
      const reads = fileReadContext(server.server.getClientCapabilities(), extra);
      const config = ensureInitialized();

      const { to, subject, text, html, cc, bcc, reply_to_message_id } = args;

      // Resolve and validate attachment paths before any network I/O.
      const resolvedAttachments = resolveOutboundAttachments(args.attachments, reads);

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
        ...(resolvedAttachments ? { attachments: resolvedAttachments } : {}),
      });

      return JSON.stringify({ ok: true, messageId });
    }),
  );

  // ── email_save_draft ────────────────────────────────────────────

  server.registerTool(
    'email_save_draft',
    {
      description:
        'Save a draft email to the Drafts folder. This mutates the remote account. When ' +
        'connected to a host that authorizes file reads, its path permission decision applies ' +
        'to attachments. ' +
        'Standalone clients require attachment files inside the workspace sandbox ' +
        '(MCP_WORKSPACE_PATH, or the system temp directory when unset).',
      _meta: { 'files/readInputs': { version: 1, inputs: [{ selector: ['attachments', '*', 'path'], base: 'connectorCwd', expandTilde: true }] } },
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
        attachments: attachmentsSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args, extra) => {
      const reads = fileReadContext(server.server.getClientCapabilities(), extra);
      const config = ensureInitialized();

      const { to, subject, text, html, reply_to_message_id, attachments } = args;

      const hasSubject = Boolean(subject && subject.trim().length > 0);
      const hasBody =
        Boolean(text && text.trim().length > 0) ||
        Boolean(html && html.trim().length > 0);
      if (!hasSubject && !hasBody) {
        throw new Error('Provide at least a subject or a text/html body');
      }

      const draft = await appendDraftMessage(config.email, {
        to,
        subject,
        text,
        html,
        reply_to_message_id,
        attachments,
      }, reads);

      return JSON.stringify({
        ok: true,
        messageId: draft.messageId,
        mailbox: wrapEmailField(draft.mailbox),
        ...(draft.uid !== undefined ? { uid: draft.uid } : {}),
      });
    }),
  );
}
