/**
 * Send/draft tools — sending emails and saving drafts.
 *
 * Security notes (M2.5):
 * - `email_send` is annotated `destructiveHint: true, openWorldHint: true`.
 *   Hosts MUST require explicit user confirmation before invoking it.
 * - A combined To+CC+BCC recipient cap (`EMAIL_IMAP_MAX_RECIPIENTS`,
 *   default 25) and a rolling rate limit
 *   (`EMAIL_IMAP_RATE_LIMIT_PER_HOUR` / `EMAIL_IMAP_RATE_LIMIT_WINDOW_MS`,
 *   default 50/hour) act as blast-radius circuit breakers against
 *   prompt-injection-driven mass sends.
 * - When either cap is exceeded, the tool returns a structured JSON
 *   error with a stable `code` (`RECIPIENT_LIMIT_EXCEEDED` or
 *   `RATE_LIMIT_EXCEEDED`); rate-cap errors include both `resetAt`
 *   (ISO-8601) and `retryAfterMs`.
 */

import { z } from 'zod';
import * as fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import nodemailer from 'nodemailer';
import { withErrorHandling } from '../utils.js';
import { getConnection } from '../imap-client.js';
import { getTransport } from '../smtp-client.js';
import { resolveReadPath, sanitizeAttachmentFilename } from '../path-safety.js';
import {
  ensureInitialized,
  generateMessageId,
  resolveDraftsMailbox,
} from './shared.js';
import {
  checkRateLimit,
  getMaxRecipients,
  recordSend,
} from './limits.js';

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
      'Path to a file inside the workspace sandbox (MCP_WORKSPACE_PATH, or the system ' +
        'temp directory when unset). Paths outside the sandbox — including via symlinks — ' +
        'are refused.',
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
 * Resolve outbound attachment paths to canonical in-workspace files and
 * enforce the aggregate size cap. Throws before any network I/O when a path
 * escapes the sandbox or the cap is exceeded.
 */
function resolveOutboundAttachments(
  attachments: OutboundAttachment[] | undefined,
): Array<{ path: string; filename?: string }> | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  const resolved: Array<{ path: string; filename?: string }> = [];
  let totalBytes = 0;
  for (const attachment of attachments) {
    const canonical = resolveReadPath(attachment.path);
    totalBytes += fs.statSync(canonical).size;
    if (totalBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments exceed the ${MAX_OUTBOUND_ATTACHMENT_BYTES}-byte aggregate cap; ` +
          'remove files or send them in separate messages.',
      );
    }
    resolved.push({
      path: canonical,
      ...(attachment.filename
        ? { filename: sanitizeAttachmentFilename(attachment.filename) }
        : {}),
    });
  }
  return resolved;
}

/**
 * Flatten a recipient field (string | string[] | undefined) into the list of
 * resolved addresses it carries, splitting any comma-delimited string entries
 * into individual addresses. This is the input to the recipient-cap check —
 * counting array length alone would let a single string like
 * `"a@x.com, b@x.com, c@x.com"` bypass the cap. The original `to`/`cc`/`bcc`
 * value is still passed through to nodemailer, which performs its own
 * downstream parsing.
 */
function toRecipientArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const entries = Array.isArray(value) ? value : [value];
  const flattened: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      continue;
    }
    for (const piece of entry.split(',')) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) {
        flattened.push(trimmed);
      }
    }
  }
  return flattened;
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
): Promise<{ messageId: string; mailbox: string; uid?: number }> {
  const { to, subject, text, html, reply_to_message_id } = fields;

  const messageId = generateMessageId(fromEmail);
  const draftTransport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
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
      ? { attachments: resolveOutboundAttachments(fields.attachments) }
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
        'This is a destructive action: hosts MUST require explicit user confirmation before each ' +
        'invocation. Combined To+CC+BCC recipient count is capped (default 25, env ' +
        '`EMAIL_IMAP_MAX_RECIPIENTS`) and outbound sends are rate-limited (default 50/hour, env ' +
        '`EMAIL_IMAP_RATE_LIMIT_PER_HOUR` / `EMAIL_IMAP_RATE_LIMIT_WINDOW_MS`). When a cap is hit, ' +
        'the tool returns a structured error with a stable `code` (`RECIPIENT_LIMIT_EXCEEDED` or ' +
        '`RATE_LIMIT_EXCEEDED`). Attachments (max 10, 25 MB total) are read only from inside ' +
        'the workspace sandbox (MCP_WORKSPACE_PATH, or the system temp directory when unset).',
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
    withErrorHandling(async (args) => {
      const config = ensureInitialized();

      const { to, subject, text, html, cc, bcc, reply_to_message_id } = args;

      // ── Recipient cap (combined To + CC + BCC) ────────────────────
      const recipientCount =
        toRecipientArray(to).length +
        toRecipientArray(cc).length +
        toRecipientArray(bcc).length;
      const maxRecipients = getMaxRecipients();
      if (recipientCount > maxRecipients) {
        return JSON.stringify({
          ok: false,
          code: 'RECIPIENT_LIMIT_EXCEEDED',
          error:
            `Recipient cap exceeded: ${recipientCount} addresses requested, ` +
            `limit is ${maxRecipients} (combined To+CC+BCC).`,
          limit: maxRecipients,
          observed: recipientCount,
          resolution:
            'Reduce the number of recipients per message or raise EMAIL_IMAP_MAX_RECIPIENTS ' +
            'after explicit user confirmation.',
        });
      }

      // ── Rolling-window rate limit ─────────────────────────────────
      const decision = checkRateLimit();
      if (!decision.allowed) {
        return JSON.stringify({
          ok: false,
          code: 'RATE_LIMIT_EXCEEDED',
          error:
            `Send rate limit exceeded: ${decision.observed} sends in the active window, ` +
            `limit is ${decision.limit}.`,
          limit: decision.limit,
          observed: decision.observed,
          resetAt: decision.resetAt,
          retryAfterMs: decision.retryAfterMs,
          resolution:
            'Retry after the window resets, or raise EMAIL_IMAP_RATE_LIMIT_PER_HOUR / ' +
            'EMAIL_IMAP_RATE_LIMIT_WINDOW_MS after explicit user confirmation.',
        });
      }

      // Resolve and validate attachment paths BEFORE recording the send
      // attempt: a sandbox violation is a caller error, not a failed send.
      const resolvedAttachments = resolveOutboundAttachments(args.attachments);

      // Record the attempt BEFORE calling the transport so that a looped
      // SMTP failure cannot bypass the cap by retrying.
      recordSend();

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
        'Save a draft email to the Drafts folder. Attachment paths must resolve inside the ' +
        'workspace sandbox (MCP_WORKSPACE_PATH, or the system temp directory when unset).',
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
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
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
      });

      return JSON.stringify({
        ok: true,
        messageId: draft.messageId,
        mailbox: draft.mailbox,
        ...(draft.uid !== undefined ? { uid: draft.uid } : {}),
      });
    }),
  );
}
