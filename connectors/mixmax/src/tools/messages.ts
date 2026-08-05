import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mixmaxFetch } from '../client.js';
import { withErrorHandling, parseApiResponse } from '../utils.js';
import { isConfigured } from '../auth.js';
import { messagesResponseSchema } from '../types.js';
import { sanitizeMessages } from '../sanitize.js';

function noApiTokenError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Mixmax API token not configured',
    resolution: 'To use Mixmax, you need to configure an API token first.',
    next_step: {
      action: 'The user adds the Mixmax API token in Settings → Connectors in the app. Do not ask for it in chat.',
      get_token_from: 'Mixmax Settings > Integrations > API Key section (requires Growth or Enterprise annual plan)',
    },
  });
}

export function registerMessageTools(server: McpServer): void {
  server.registerTool(
    'list_mixmax_messages',
    {
      description:
        `List emails in Mixmax: drafts, scheduled sends, and sent messages.

Returns for each message:
- _id, subject, from, and to/cc/bcc recipients
- sent / scheduled: epoch-ms timestamps. A message with "scheduled" but no "sent" is scheduled to send — cancel it with cancel_mixmax_message.
- trackingEnabled / linkTrackingEnabled flags

USE CASES:
- "Show my recent emails" — call with no params
- "What emails are scheduled?" — look for messages with a "scheduled" timestamp
- Open/click/reply aggregates per message, template, or sequence — use get_mixmax_report

PAGINATION: Cursor-based. If hasNext is true, pass the "next" value as the next parameter.`,
      inputSchema: z.object({
        limit: z.number().min(1).max(100).default(25).describe('Maximum results to return (default: 25)'),
        next: z.string().optional().describe('Cursor for next page (from previous response)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiTokenError();

      let path = `/messages?limit=${args.limit}`;
      if (args.next) path += `&next=${encodeURIComponent(args.next)}`;

      const data = parseApiResponse(
        messagesResponseSchema,
        await mixmaxFetch<unknown>(path),
        'messages list',
      );

      return JSON.stringify({
        ok: true,
        messages: sanitizeMessages(data.results),
        count: data.results.length,
        hasNext: data.hasNext ?? false,
        ...(data.next ? { next: data.next } : {}),
      });
    }),
  );

  server.registerTool(
    'send_mixmax_email',
    {
      description:
        `Send an email via Mixmax through the user's connected Gmail account.

IMPORTANT: Confirm with the user before sending — this sends a real email immediately.

BODY FORMAT: HTML is supported. Use <p>, <br>, <b>, <ul>, etc. for formatting. Plain text also works.

NOTE: This sends through Mixmax, not raw Gmail. The email will appear in the user's Gmail sent folder. To schedule a send for later, use send_mixmax_snippet with the scheduledAt parameter instead (the /send API sends immediately).`,
      inputSchema: z.object({
        to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
        subject: z.string().min(1).describe('Email subject line'),
        body: z.string().min(1).describe('Email body (HTML supported — use <p>, <br>, <b>, <ul> for formatting)'),
        cc: z.array(z.string().email()).optional().describe('CC recipient email addresses (optional)'),
        bcc: z.array(z.string().email()).optional().describe('BCC recipient email addresses (optional)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiTokenError();

      const payload: Record<string, unknown> = {
        to: args.to.map((email) => ({ email })),
        subject: args.subject,
        body: args.body,
      };
      if (args.cc && args.cc.length > 0) payload.cc = args.cc.map((email) => ({ email }));
      if (args.bcc && args.bcc.length > 0) payload.bcc = args.bcc.map((email) => ({ email }));

      const data = await mixmaxFetch<Record<string, unknown>>('/send', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      return JSON.stringify({
        ok: true,
        message: `Email sent to ${args.to.join(', ')}.`,
        result: data,
      });
    }),
  );

  server.registerTool(
    'cancel_mixmax_message',
    {
      description:
        `Cancel a scheduled (not yet sent) Mixmax message, recalling it before it goes out.

IMPORTANT: Confirm with the user before calling — this is irreversible.

WORKFLOW:
1. list_mixmax_messages and find the message with a "scheduled" timestamp and no "sent" timestamp
2. Confirm the subject/recipients with the user
3. Call this tool with the message _id

NOTE: Only messages that have not been sent yet can be cancelled. An already-sent email CANNOT be recalled.`,
      inputSchema: z.object({
        messageId: z.string().min(1).describe('The _id of the scheduled message (from list_mixmax_messages)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiTokenError();

      await mixmaxFetch<unknown>(`/messages/${encodeURIComponent(args.messageId)}`, {
        method: 'DELETE',
      });

      return JSON.stringify({
        ok: true,
        message: 'Message cancelled. If it was scheduled, it will not be sent.',
      });
    }),
  );
}
