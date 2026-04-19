import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mixmaxFetch } from '../client.js';
import { withErrorHandling } from '../utils.js';
import { isConfigured } from '../auth.js';
import type { MessagesResponse } from '../types.js';

function noApiTokenError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Mixmax API token not configured',
    resolution: 'To use Mixmax, you need to configure an API token first.',
    next_step: {
      action: 'Ask the user for their Mixmax API token, then call configure_mixmax_api_key',
      tool_to_call: 'configure_mixmax_api_key',
      tool_parameters: { api_key: '<user_provided_token>' },
      get_token_from: 'Mixmax Settings > Integrations > API Key section (requires Growth or Enterprise annual plan)',
    },
  });
}

export function registerMessageTools(server: McpServer): void {
  server.registerTool(
    'list_mixmax_messages',
    {
      description:
        `List emails sent through Mixmax with open/click tracking data.

Returns for each message:
- _id, subject, recipients (to/cc/bcc)
- sentAt / scheduledAt: When it was sent or is scheduled
- opens: Number of times opened, with timestamps
- clicks: Links clicked, with URLs and timestamps
- state: "sent", "draft", or "scheduled"

USE CASES:
- "Show my recent emails" — call with no params
- "Did they open my email?" — find the message, check opens count/timestamps
- "What emails are scheduled?" — look for state: "scheduled"

PAGINATION: Cursor-based. If hasNext is true, pass the "next" value as the next parameter.`,
      inputSchema: z.object({
        limit: z.number().min(1).max(100).default(25).describe('Maximum results to return (default: 25)'),
        next: z.string().optional().describe('Cursor for next page (from previous response)'),
      }),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiTokenError();

      let path = `/messages?limit=${args.limit}`;
      if (args.next) path += `&next=${encodeURIComponent(args.next)}`;

      const data = await mixmaxFetch<MessagesResponse>(path);

      return JSON.stringify({
        ok: true,
        messages: data.results || [],
        count: (data.results || []).length,
        hasNext: data.hasNext ?? false,
        ...(data.next ? { next: data.next } : {}),
      });
    }),
  );

  server.registerTool(
    'send_mixmax_email',
    {
      description:
        `Send an email via Mixmax through the user's connected Gmail account. Open and click tracking is enabled automatically.

IMPORTANT: Confirm with the user before sending — this sends a real email immediately.

BODY FORMAT: HTML is supported. Use <p>, <br>, <b>, <ul>, etc. for formatting. Plain text also works.

TRACKING: Mixmax automatically tracks opens and clicks. The user can check tracking data later via list_mixmax_messages.

NOTE: This sends through Mixmax, not raw Gmail. The email will appear in the user's Gmail sent folder with Mixmax tracking pixels.`,
      inputSchema: z.object({
        to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
        subject: z.string().min(1).describe('Email subject line'),
        body: z.string().min(1).describe('Email body (HTML supported — use <p>, <br>, <b>, <ul> for formatting)'),
        cc: z.array(z.string().email()).optional().describe('CC recipient email addresses (optional)'),
        bcc: z.array(z.string().email()).optional().describe('BCC recipient email addresses (optional)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
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
}
