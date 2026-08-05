import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { hasScope } from '@mindstone/mcp-server-microsoft-shared';
import { callGraph, getTokenProvider } from './client.js';
import { handleComposeEmail } from './compose.js';
import {
  authRequiredJson,
  errorResponse,
  successJson,
  withErrorHandling,
} from './utils.js';
import { AUTH_TOOL_NAME } from './types.js';
import {
  createDraft,
  createReplyDraft,
  deleteEmail,
  downloadAttachment,
  forwardEmail,
  getAutomaticReplies,
  getConversation,
  getEmail,
  listAttachments,
  listEmails,
  listFolders,
  markEmailRead,
  moveEmail,
  normalizeScheduledWindow,
  replyToEmail,
  searchEmails,
  sendDraft,
  sendEmail,
  setAutomaticReplies,
  setEmailFlag,
  updateDraft,
} from './mail.js';

// Bounded, validated recipient addresses: trimmed, RFC-shaped, and capped in
// length and count so arbitrary strings cannot flow into a Graph send payload.
const MAX_RECIPIENT_ADDRESS_LENGTH = 254;
const MAX_RECIPIENT_COUNT = 500;
const EmailAddress = z.string().trim().max(MAX_RECIPIENT_ADDRESS_LENGTH).email();
const RecipientList = z.array(EmailAddress).max(MAX_RECIPIENT_COUNT);
const RecipientField = z.union([RecipientList, EmailAddress]);

const ImportanceEnum = z.enum(['low', 'normal', 'high']);

// Automatic-replies management lives under MailboxSettings, a separate Graph
// permission family from Mail.* that many tenants gate behind admin consent
// (mirrors the SharePoint Sites.Read.All gate in microsoft-sharepoint).
const MAILBOX_SETTINGS_READ_SCOPES = ['MailboxSettings.Read', 'MailboxSettings.ReadWrite'];
const MAILBOX_SETTINGS_WRITE_SCOPE = 'MailboxSettings.ReadWrite';

async function requireMailboxSettingsScope(write: boolean): Promise<CallToolResult | null> {
  const guidance = {
    action_required: `Call ${AUTH_TOOL_NAME} and grant the MailboxSettings permissions. Note: in many organizations an administrator must approve additional Microsoft Graph permissions.`,
    next_step: AUTH_TOOL_NAME,
  };
  try {
    const tokenData = await getTokenProvider().loadToken();
    if (!tokenData) {
      return errorResponse({
        error: 'No Microsoft account connected.',
        ...guidance,
      });
    }
    const granted = write
      ? hasScope(tokenData.scope, MAILBOX_SETTINGS_WRITE_SCOPE)
      : MAILBOX_SETTINGS_READ_SCOPES.some((scope) => hasScope(tokenData.scope, scope));
    if (!granted) {
      return errorResponse({
        error: `Automatic-replies management requires the ${
          write ? MAILBOX_SETTINGS_WRITE_SCOPE : 'MailboxSettings.Read'
        } permission, which this Microsoft connection has not granted.`,
        ...guidance,
      });
    }
    return null;
  } catch (err) {
    return errorResponse({
      error: `Failed to check mailbox-settings permissions: ${
        err instanceof Error ? err.message : String(err)
      }`,
      ...guidance,
    });
  }
}

// send_email accepts unknown keys so the handler can surface bundled-parity
// alias guidance (`recipient`/`recipients`, `message`/`content`/`text`)
// rather than letting Zod silently strip them.
const SendEmailSchema = z
  .object({
    to: RecipientField.optional().describe(
      'Recipient email address(es). Use an array: ["alice@example.com"]',
    ),
    subject: z.string().optional().describe('Email subject'),
    body: z.string().optional().describe('Email body (HTML supported)'),
    cc: RecipientField.optional().describe('CC recipient(s)'),
    bcc: RecipientField.optional().describe('BCC recipient(s)'),
    importance: ImportanceEnum.optional().describe('Email importance'),
  })
  .passthrough();

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
    withErrorHandling(async (args, extra) => {
      const result = await callGraph(extra, (c, signal) => listEmails(c, args, signal));
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
    withErrorHandling(async (args, extra) => {
      if (!args.id) {
        return errorResponse({
          error:
            'Missing required parameter: "id" (the email message ID). Example: { "id": "AAMkAGI2..." }. Use list_emails to find message IDs.',
          action_required: 'Provide the message ID returned by list_emails.',
          next_step: 'list_emails',
        });
      }
      const result = await callGraph(extra, (c, signal) => getEmail(c, { id: args.id! }, signal));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // get_conversation
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_conversation',
    {
      description:
        'List all messages in an email thread (conversation), oldest first. Provide a message ID from list_emails/search_emails or a conversationId.',
      inputSchema: z.object({
        id: z
          .string()
          .optional()
          .describe('Any message ID in the thread; its conversationId is resolved automatically'),
        conversationId: z
          .string()
          .optional()
          .describe('Graph conversation ID, if already known'),
        top: z.number().optional().describe('Number of messages to return (default: 25, max: 100)'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.id && !args.conversationId) {
        return errorResponse({
          error:
            'Missing required parameter: "id" (any message ID in the thread) or "conversationId". Example: { "id": "AAMkAGI2..." }. Use list_emails or search_emails to find message IDs.',
          action_required: 'Provide a message ID or a conversationId.',
          next_step: 'list_emails',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        getConversation(
          c,
          { id: args.id, conversationId: args.conversationId, top: args.top },
          signal,
        ),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // list_attachments
  // ---------------------------------------------------------------------
  server.registerTool(
    'list_attachments',
    {
      description:
        'List attachments on an email message. Returns attachment IDs, names, types, and sizes. Use download_attachment to save one locally.',
      inputSchema: z.object({
        id: z.string().optional().describe('Email message ID'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.id) {
        return errorResponse({
          error:
            'Missing required parameter: "id" (the email message ID). Example: { "id": "AAMkAGI2..." }. Use list_emails or search_emails to find message IDs; messages with hasAttachments=true have attachments.',
          action_required: 'Provide the message ID of an email that has attachments.',
          next_step: 'list_emails',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        listAttachments(c, { id: args.id! }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // download_attachment
  // ---------------------------------------------------------------------
  server.registerTool(
    'download_attachment',
    {
      description:
        'Download an email attachment and save it into the workspace (MCP_WORKSPACE_PATH, or the OS temp directory when unset). Use list_attachments to find attachment IDs. Saving requires descriptor-pinned directory writes (Linux); on other platforms the tool refuses to save rather than risk the file landing outside the workspace.',
      inputSchema: z.object({
        id: z.string().optional().describe('Email message ID'),
        attachmentId: z
          .string()
          .optional()
          .describe('Attachment ID from list_attachments'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.id || !args.attachmentId) {
        return errorResponse({
          error:
            'Missing required parameters: "id" (email message ID) and "attachmentId" (attachment to save). Example: { "id": "AAMkAGI2...", "attachmentId": "AAMkADA1..." }. Use list_attachments to find attachment IDs.',
          action_required: 'Provide both the message ID and the attachment ID.',
          next_step: 'list_attachments',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        downloadAttachment(c, { id: args.id!, attachmentId: args.attachmentId! }, signal),
      );
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
        'Send a new email message. "to", "cc", and "bcc" accept a string or an array of strings. Prefer arrays for multiple recipients (e.g. ["alice@example.com"]).',
      inputSchema: SendEmailSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if ('recipient' in args || 'recipients' in args) {
        return errorResponse({
          error:
            'Invalid parameter: Use "to" instead of "recipient"/"recipients". Example: { "to": ["alice@example.com"], "subject": "Hello", "body": "Message content" }',
          action_required: 'Use the "to" parameter (string or array of strings).',
          next_step: 'send_email',
        });
      }
      if ('message' in args || 'content' in args || 'text' in args) {
        return errorResponse({
          error:
            'Invalid parameter: Use "body" instead of "message"/"content"/"text". Example: { "to": ["alice@example.com"], "subject": "Hello", "body": "Message content" }',
          action_required: 'Use the "body" parameter to provide the email content.',
          next_step: 'send_email',
        });
      }
      const toList = Array.isArray(args.to) ? args.to : args.to ? [args.to] : [];
      if (!toList.length || !args.subject || !args.body) {
        return errorResponse({
          error:
            'Missing required parameters. Required: "to" (string or array), "subject" (string), "body" (string). Example: { "to": ["recipient@example.com"], "subject": "Meeting Tomorrow", "body": "Hi, let\'s meet at 3pm." }',
          action_required: 'Provide to, subject, and body fields.',
          next_step: 'send_email',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        sendEmail(
          c,
          {
            to: args.to as string | string[],
            subject: args.subject as string,
            body: args.body as string,
            cc: args.cc as string | string[] | undefined,
            bcc: args.bcc as string | string[] | undefined,
            importance: args.importance as 'low' | 'normal' | 'high' | undefined,
          },
          signal,
        ),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // compose_email
  // ---------------------------------------------------------------------
  // Registered without withErrorHandling: the handler does no Graph I/O, and
  // its McpError(InvalidParams) validation failure must surface as-is rather
  // than as an auth-flavoured retry envelope.
  server.registerTool(
    'compose_email',
    {
      description:
        'Open an inline editable email compose form before sending. Use this when the user wants to write or send an email, so they can review and edit the draft first. Do NOT use when the user asks to save a draft (use create_draft). This tool does not send the email directly.',
      inputSchema: z.object({
        to: RecipientList.min(1).describe('Recipient email address(es), e.g. ["alice@example.com"]'),
        cc: RecipientList.optional().describe('CC recipient(s)'),
        bcc: RecipientList.optional().describe('BCC recipient(s)'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => handleComposeEmail(args),
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
          .optional()
          .describe('Search query (e.g., "from:john subject:meeting")'),
        top: z.number().optional().describe('Number of results (default: 25)'),
      }).shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.query) {
        return errorResponse({
          error:
            'Missing required parameter: "query" (search text). Example: { "query": "project update", "top": 20 }',
          action_required: 'Provide a non-empty query string.',
          next_step: 'search_emails',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        searchEmails(c, { query: args.query!, top: args.top }, signal),
      );
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
        id: z.string().optional().describe('Original email message ID'),
        body: z.string().optional().describe('Reply body (HTML supported)'),
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
    withErrorHandling(async (args, extra) => {
      if (!args.id || !args.body) {
        return errorResponse({
          error:
            'Missing required parameters: "id" (email to reply to) and "body" (reply content). Example: { "id": "AAMkAGI2...", "body": "Thanks for your message!", "replyAll": false }',
          action_required: 'Provide both id and body.',
          next_step: 'reply_to_email',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        replyToEmail(c, { id: args.id!, body: args.body!, replyAll: args.replyAll }, signal),
      );
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
        id: z.string().optional().describe('Email message ID to forward'),
        to: RecipientField.optional().describe('Recipient(s) to forward to'),
        comment: z.string().optional().describe('Optional comment to add'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      const toList = Array.isArray(args.to) ? args.to : args.to ? [args.to] : [];
      if (!args.id || !toList.length) {
        return errorResponse({
          error:
            'Missing required parameters: "id" (email to forward) and "to" (string or array). Example: { "id": "AAMkAGI2...", "to": ["colleague@example.com"], "comment": "FYI" }',
          action_required: 'Provide both id and to.',
          next_step: 'forward_email',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        forwardEmail(
          c,
          { id: args.id!, to: args.to as string | string[], comment: args.comment },
          signal,
        ),
      );
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
        id: z.string().optional().describe('Email message ID'),
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
    withErrorHandling(async (args, extra) => {
      if (!args.id) {
        return errorResponse({
          error:
            'Missing required parameter: "id" (email to delete). Example: { "id": "AAMkAGI2...", "permanent": false }. Set "permanent": true to permanently delete instead of moving to Deleted Items.',
          action_required: 'Provide the message ID.',
          next_step: 'delete_email',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        deleteEmail(c, { id: args.id!, permanent: args.permanent }, signal),
      );
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
    withErrorHandling(async (args, extra) => {
      const result = await callGraph(extra, (c, signal) => listFolders(c, args, signal));
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
        id: z.string().optional().describe('Email message ID'),
        destinationFolder: z
          .string()
          .optional()
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
    withErrorHandling(async (args, extra) => {
      if (!args.id || !args.destinationFolder) {
        return errorResponse({
          error:
            'Missing required parameters: "id" (email to move) and "destinationFolder" (target folder). Example: { "id": "AAMkAGI2...", "destinationFolder": "inbox" }. Use list_folders to find folder IDs.',
          action_required: 'Provide id and destinationFolder.',
          next_step: 'list_folders',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        moveEmail(c, { id: args.id!, destinationFolder: args.destinationFolder! }, signal),
      );
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
        id: z.string().optional().describe('Original email message ID to reply to'),
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
    withErrorHandling(async (args, extra) => {
      if (!args.id) {
        return errorResponse({
          error:
            'Missing required parameter: "id" (the email message ID to reply to). Example: { "id": "AAMkAGI2...", "body": "Thanks for your message!" }',
          action_required: 'Provide the message ID.',
          next_step: 'list_emails',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        createReplyDraft(c, { id: args.id!, body: args.body, replyAll: args.replyAll }, signal),
      );
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
        subject: z.string().optional().describe('Email subject'),
        body: z.string().optional().describe('Email body (HTML supported)'),
        cc: RecipientField.optional().describe('CC recipient(s)'),
        bcc: RecipientField.optional().describe('BCC recipient(s)'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.subject || !args.body) {
        return errorResponse({
          error:
            'Missing required parameters: "subject" and "body". Example: { "to": ["recipient@example.com"], "subject": "Draft Email", "body": "Content here..." }',
          action_required: 'Provide subject and body.',
          next_step: 'create_draft',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        createDraft(
          c,
          {
            to: args.to,
            subject: args.subject!,
            body: args.body!,
            cc: args.cc,
            bcc: args.bcc,
          },
          signal,
        ),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // mark_email_read
  // ---------------------------------------------------------------------
  server.registerTool(
    'mark_email_read',
    {
      description: 'Mark an email as read or unread.',
      inputSchema: z.object({
        id: z.string().optional().describe('Email message ID'),
        isRead: z
          .boolean()
          .optional()
          .describe('true to mark as read, false to mark as unread (default: true)'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.id) {
        return errorResponse({
          error:
            'Missing required parameter: "id" (the email message ID). Example: { "id": "AAMkAGI2...", "isRead": true }',
          action_required: 'Provide the message ID.',
          next_step: 'list_emails',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        markEmailRead(c, { id: args.id!, isRead: args.isRead }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // set_email_flag
  // ---------------------------------------------------------------------
  server.registerTool(
    'set_email_flag',
    {
      description:
        'Flag an email for follow-up, mark a follow-up complete, or clear the flag.',
      inputSchema: z.object({
        id: z.string().optional().describe('Email message ID'),
        flag: z
          .enum(['flagged', 'complete', 'notFlagged'])
          .optional()
          .describe(
            'Follow-up state: "flagged" (flag for follow-up), "complete" (mark done), "notFlagged" (clear the flag)',
          ),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.id || !args.flag) {
        return errorResponse({
          error:
            'Missing required parameters: "id" (email message ID) and "flag" ("flagged", "complete", or "notFlagged"). Example: { "id": "AAMkAGI2...", "flag": "flagged" }',
          action_required: 'Provide both id and flag.',
          next_step: 'set_email_flag',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        setEmailFlag(c, { id: args.id!, flag: args.flag! }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // send_draft
  // ---------------------------------------------------------------------
  server.registerTool(
    'send_draft',
    {
      description:
        'Send an existing draft email (created by create_draft or create_reply_draft). The draft is sent and saved to Sent Items.',
      inputSchema: z.object({
        id: z.string().optional().describe('Draft message ID (draftId from create_draft)'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.id) {
        return errorResponse({
          error:
            'Missing required parameter: "id" (the draft message ID). Example: { "id": "AAMkAGI2..." }. Use the draftId returned by create_draft or create_reply_draft, or list the drafts folder with list_emails.',
          action_required: 'Provide the draft message ID.',
          next_step: 'create_draft',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        sendDraft(c, { id: args.id! }, signal),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // update_draft
  // ---------------------------------------------------------------------
  server.registerTool(
    'update_draft',
    {
      description:
        'Update an existing draft email. Only the provided fields are changed (subject, body, to, cc, importance). Use send_draft to send it afterwards.',
      inputSchema: z.object({
        id: z.string().optional().describe('Draft message ID (draftId from create_draft)'),
        to: RecipientField.optional().describe('Replace the recipient list'),
        cc: RecipientField.optional().describe('Replace the CC recipient list'),
        subject: z.string().optional().describe('New email subject'),
        body: z.string().optional().describe('New email body (HTML supported)'),
        importance: ImportanceEnum.optional().describe('Email importance'),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.id) {
        return errorResponse({
          error:
            'Missing required parameter: "id" (the draft message ID). Example: { "id": "AAMkAGI2...", "subject": "Updated subject" }. Use the draftId returned by create_draft or create_reply_draft.',
          action_required: 'Provide the draft message ID.',
          next_step: 'create_draft',
        });
      }
      if (
        args.to === undefined &&
        args.cc === undefined &&
        args.subject === undefined &&
        args.body === undefined &&
        args.importance === undefined
      ) {
        return errorResponse({
          error:
            'Nothing to update. Provide at least one of "to", "cc", "subject", "body", or "importance". Example: { "id": "AAMkAGI2...", "body": "Updated content" }',
          action_required: 'Provide at least one field to update.',
          next_step: 'update_draft',
        });
      }
      const result = await callGraph(extra, (c, signal) =>
        updateDraft(
          c,
          {
            id: args.id!,
            to: args.to,
            cc: args.cc,
            subject: args.subject,
            body: args.body,
            importance: args.importance,
          },
          signal,
        ),
      );
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // get_automatic_replies
  // ---------------------------------------------------------------------
  server.registerTool(
    'get_automatic_replies',
    {
      description:
        'Read the current out-of-office (automatic replies) configuration: status, internal/external messages, and schedule. Requires the MailboxSettings.Read permission.',
      inputSchema: z.object({}).strict().shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (_args, extra) => {
      const scopeError = await requireMailboxSettingsScope(false);
      if (scopeError) return scopeError;
      const result = await callGraph(extra, (c, signal) => getAutomaticReplies(c, signal));
      return successJson(result);
    }),
  );

  // ---------------------------------------------------------------------
  // set_automatic_replies
  // ---------------------------------------------------------------------
  server.registerTool(
    'set_automatic_replies',
    {
      description:
        'Turn out-of-office (automatic replies) on, off, or schedule it. Status "scheduled" requires scheduledStart and scheduledEnd. Requires the MailboxSettings.ReadWrite permission.',
      inputSchema: z.object({
        status: z
          .enum(['disabled', 'alwaysEnabled', 'scheduled'])
          .optional()
          .describe(
            '"alwaysEnabled" turns automatic replies on until changed, "scheduled" turns them on between scheduledStart and scheduledEnd, "disabled" turns them off',
          ),
        internalReplyMessage: z
          .string()
          .optional()
          .describe('Reply sent to people inside the organization (HTML supported)'),
        externalReplyMessage: z
          .string()
          .optional()
          .describe('Reply sent to people outside the organization (HTML supported)'),
        externalAudience: z
          .enum(['none', 'contactsOnly', 'all'])
          .optional()
          .describe('Who outside the organization receives the external reply (default: none)'),
        scheduledStart: z
          .string()
          .optional()
          .describe(
            'Start of the scheduled window as an ISO 8601 date-time (e.g. "2026-08-10T09:00:00Z"); explicit offsets are converted to UTC, zone-less values are treated as UTC',
          ),
        scheduledEnd: z
          .string()
          .optional()
          .describe(
            'End of the scheduled window as an ISO 8601 date-time (e.g. "2026-08-14T18:00:00Z"); explicit offsets are converted to UTC, zone-less values are treated as UTC',
          ),
      }).shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args, extra) => {
      if (!args.status) {
        return errorResponse({
          error:
            'Missing required parameter: "status" ("disabled", "alwaysEnabled", or "scheduled"). Example: { "status": "alwaysEnabled", "internalReplyMessage": "I am away until Friday." }',
          action_required: 'Provide the automatic-replies status.',
          next_step: 'set_automatic_replies',
        });
      }
      if (args.status === 'scheduled' && (!args.scheduledStart || !args.scheduledEnd)) {
        return errorResponse({
          error:
            'Status "scheduled" requires "scheduledStart" and "scheduledEnd" (ISO 8601 date-times, e.g. "2026-08-10T09:00:00Z").',
          action_required: 'Provide scheduledStart and scheduledEnd.',
          next_step: 'set_automatic_replies',
        });
      }
      if (args.status === 'scheduled') {
        try {
          normalizeScheduledWindow(args.scheduledStart, args.scheduledEnd);
        } catch (err) {
          return errorResponse({
            error: err instanceof Error ? err.message : String(err),
            action_required:
              'Provide ISO 8601 date-times with an explicit offset or "Z" (or a UTC wall-clock time), with scheduledStart earlier than scheduledEnd.',
            next_step: 'set_automatic_replies',
          });
        }
      }
      const scopeError = await requireMailboxSettingsScope(true);
      if (scopeError) return scopeError;
      const result = await callGraph(extra, (c, signal) =>
        setAutomaticReplies(
          c,
          {
            status: args.status!,
            internalReplyMessage: args.internalReplyMessage,
            externalReplyMessage: args.externalReplyMessage,
            externalAudience: args.externalAudience,
            scheduledStart: args.scheduledStart,
            scheduledEnd: args.scheduledEnd,
          },
          signal,
        ),
      );
      return successJson(result);
    }),
  );
}
