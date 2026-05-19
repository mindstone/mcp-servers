import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withGraphRetry } from './client.js';
import {
  authRequiredJson,
  errorJson,
  successJson,
  withErrorHandling,
} from './utils.js';
import { AUTH_TOOL_NAME } from './types.js';
import {
  createDraft,
  createReplyDraft,
  deleteEmail,
  forwardEmail,
  getEmail,
  listEmails,
  listFolders,
  moveEmail,
  replyToEmail,
  searchEmails,
  sendEmail,
} from './mail.js';

const RecipientField = z.union([z.array(z.string()), z.string()]);

const ImportanceEnum = z.enum(['low', 'normal', 'high']);

export function registerMailTools(server: McpServer): void {
  // ---------------------------------------------------------------------
  // authenticate_microsoft_account
  // ---------------------------------------------------------------------
  server.registerTool(
    AUTH_TOOL_NAME,
    {
      description: `Connect a Microsoft 365 account to enable email, calendar, files, and Teams access.

Call this tool when:
1. Other Microsoft tools return authentication errors
2. The user asks to connect or set up Microsoft 365

This tool returns a structured auth_required response. The host will
recognise it and dispatch the desktop OAuth flow. After the user completes
sign-in, Microsoft 365 tools become available.`,
      inputSchema: z.object({}).strict().shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    withErrorHandling(async () => authRequiredJson()),
  );

  // ---------------------------------------------------------------------
  // list_emails
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_emails',
    {
      description:
        'List emails from inbox or a specific folder. Returns subject, sender, date, and preview.',
      inputSchema: z.object({
        folder: z
          .string()
          .optional()
          .describe(
            'Well-known folder name (inbox, sentitems, drafts, deleteditems, junkemail, archive, outbox), display name (e.g. "Sent Items"), or folder ID from list_folders. Default: Inbox.',
          ),
        top: z.number().optional().describe('Number of emails to return (default: 25, max: 100)'),
        filter: z
          .string()
          .optional()
          .describe('OData filter expression (e.g., "isRead eq false")'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const result = await withGraphRetry((c) => listEmails(c, args));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // get_email
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_email',
    {
      description: 'Get full email content including body by message ID.',
      inputSchema: z.object({
        id: z.string().optional().describe('Email message ID'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (!args.id) {
        return errorJson({
          error:
            'Missing required parameter: "id" (the email message ID). Example: { "id": "AAMkAGI2..." }. Use list_emails to find message IDs.',
          action_required: 'Provide the message ID returned by list_emails.',
          next_step: 'list_emails',
        });
      }
      const result = await withGraphRetry((c) => getEmail(c, { id: args.id! }));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // send_email
  // ---------------------------------------------------------------------
  server.registerTool(
    'send_email',
    {
      description:
        'Send a new email message. "to" and "cc" accept a string or an array of strings. Prefer arrays for multiple recipients (e.g. ["alice@example.com"]).',
      inputSchema: z.object({
        to: RecipientField.describe(
          'Recipient email address(es). Use an array: ["alice@example.com"]',
        ),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body (HTML supported)'),
        cc: RecipientField.optional().describe('CC recipient(s)'),
        importance: ImportanceEnum.optional().describe('Email importance'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const toList = Array.isArray(args.to) ? args.to : args.to ? [args.to] : [];
      if (!toList.length || !args.subject || !args.body) {
        return errorJson({
          error:
            'Missing required parameters. Required: "to" (string or array), "subject" (string), "body" (string). Example: { "to": ["recipient@example.com"], "subject": "Meeting Tomorrow", "body": "Hi, let\'s meet at 3pm." }',
          action_required: 'Provide to, subject, and body fields.',
          next_step: 'send_email',
        });
      }
      const result = await withGraphRetry((c) => sendEmail(c, args));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // search_emails
  // ---------------------------------------------------------------------
  server.registerTool(
    'search_emails',
    {
      description: 'Search emails using Microsoft Search query syntax.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe('Search query (e.g., "from:john subject:meeting")'),
        top: z.number().optional().describe('Number of results (default: 25)'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (!args.query) {
        return errorJson({
          error:
            'Missing required parameter: "query" (search text). Example: { "query": "project update", "top": 20 }',
          action_required: 'Provide a non-empty query string.',
          next_step: 'search_emails',
        });
      }
      const result = await withGraphRetry((c) => searchEmails(c, args));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // reply_to_email
  // ---------------------------------------------------------------------
  server.registerTool(
    'reply_to_email',
    {
      description: 'Reply to an email message.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Original email message ID'),
        body: z.string().describe('Reply body (HTML supported)'),
        replyAll: z
          .boolean()
          .optional()
          .describe('Reply to all recipients (default: false)'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (!args.id || !args.body) {
        return errorJson({
          error:
            'Missing required parameters: "id" (email to reply to) and "body" (reply content). Example: { "id": "AAMkAGI2...", "body": "Thanks for your message!", "replyAll": false }',
          action_required: 'Provide both id and body.',
          next_step: 'reply_to_email',
        });
      }
      const result = await withGraphRetry((c) => replyToEmail(c, args));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // forward_email
  // ---------------------------------------------------------------------
  server.registerTool(
    'forward_email',
    {
      description: 'Forward an email to other recipients.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Email message ID to forward'),
        to: RecipientField.describe('Recipient(s) to forward to'),
        comment: z.string().optional().describe('Optional comment to add'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const toList = Array.isArray(args.to) ? args.to : args.to ? [args.to] : [];
      if (!args.id || !toList.length) {
        return errorJson({
          error:
            'Missing required parameters: "id" (email to forward) and "to" (string or array). Example: { "id": "AAMkAGI2...", "to": ["colleague@example.com"], "comment": "FYI" }',
          action_required: 'Provide both id and to.',
          next_step: 'forward_email',
        });
      }
      const result = await withGraphRetry((c) => forwardEmail(c, args));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // delete_email
  // ---------------------------------------------------------------------
  server.registerTool(
    'delete_email',
    {
      description: 'Delete or move an email to trash.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Email message ID'),
        permanent: z
          .boolean()
          .optional()
          .describe(
            'Permanently delete (default: false, moves to Deleted Items)',
          ),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (!args.id) {
        return errorJson({
          error:
            'Missing required parameter: "id" (email to delete). Example: { "id": "AAMkAGI2...", "permanent": false }. Set "permanent": true to permanently delete instead of moving to Deleted Items.',
          action_required: 'Provide the message ID.',
          next_step: 'delete_email',
        });
      }
      const result = await withGraphRetry((c) => deleteEmail(c, args));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // list_folders
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_folders',
    {
      description:
        'List mail folders (Inbox, Sent, Drafts, etc.). Returns folder IDs that can be used with list_emails and move_email.',
      inputSchema: z.object({
        includeHidden: z
          .boolean()
          .optional()
          .describe('Include hidden folders (default: false)'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const result = await withGraphRetry((c) => listFolders(c, args));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // move_email
  // ---------------------------------------------------------------------
  server.registerTool(
    'move_email',
    {
      description: 'Move an email to a different folder.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Email message ID'),
        destinationFolder: z
          .string()
          .min(1)
          .describe(
            'Well-known folder name (inbox, sentitems, drafts, deleteditems, junkemail, archive, outbox), display name, or folder ID from list_folders',
          ),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (!args.id || !args.destinationFolder) {
        return errorJson({
          error:
            'Missing required parameters: "id" (email to move) and "destinationFolder" (target folder). Example: { "id": "AAMkAGI2...", "destinationFolder": "inbox" }. Use list_folders to find folder IDs.',
          action_required: 'Provide id and destinationFolder.',
          next_step: 'list_folders',
        });
      }
      const result = await withGraphRetry((c) => moveEmail(c, args));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // create_reply_draft
  // ---------------------------------------------------------------------
  server.registerTool(
    'create_reply_draft',
    {
      description:
        'Create a draft reply to an existing email, threaded in the same conversation. The draft is saved in Drafts and can be reviewed in Outlook before sending.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Original email message ID to reply to'),
        body: z
          .string()
          .optional()
          .describe(
            'Reply body (HTML supported). If omitted, creates a blank reply draft.',
          ),
        replyAll: z
          .boolean()
          .optional()
          .describe('Reply to all recipients (default: false)'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (!args.id) {
        return errorJson({
          error:
            'Missing required parameter: "id" (the email message ID to reply to). Example: { "id": "AAMkAGI2...", "body": "Thanks for your message!" }',
          action_required: 'Provide the message ID.',
          next_step: 'list_emails',
        });
      }
      const result = await withGraphRetry((c) => createReplyDraft(c, args));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // create_draft
  // ---------------------------------------------------------------------
  server.registerTool(
    'create_draft',
    {
      description:
        'Create a new standalone draft email (saved but not sent). For replying to an existing thread, use create_reply_draft instead.',
      inputSchema: z.object({
        to: RecipientField.optional().describe('Recipient email address(es)'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body (HTML supported)'),
        cc: RecipientField.optional().describe('CC recipient(s)'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (!args.subject || !args.body) {
        return errorJson({
          error:
            'Missing required parameters: "subject" and "body". Example: { "to": ["recipient@example.com"], "subject": "Draft Email", "body": "Content here..." }',
          action_required: 'Provide subject and body.',
          next_step: 'create_draft',
        });
      }
      const result = await withGraphRetry((c) => createDraft(c, args));
      return successJson(result);
    }),
  );
}
