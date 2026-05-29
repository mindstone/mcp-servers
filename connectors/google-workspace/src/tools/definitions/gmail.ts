import { ToolMetadata } from "../../modules/tools/registry.js";

// Gmail Tools
export const gmailTools: ToolMetadata[] = [
  // --- Individual attachment tools (replaced legacy manage_workspace_attachment) ---

  {
    name: 'download_workspace_attachment',
    category: 'Gmail/Messages',
    description: `Download an attachment from a Gmail message or Calendar event to local storage. Returns attachment metadata including the local file path.`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the workspace account'
        },
        source: {
          type: 'string',
          enum: ['email', 'calendar'],
          description: 'Source type (email or calendar)'
        },
        message_id: {
          type: 'string',
          description: 'ID of the email/event containing the attachment'
        },
        filename: {
          type: 'string',
          description: 'Name of the attachment to download'
        }
      },
      required: ['source', 'message_id', 'filename']
    }
  },
  {
    name: 'upload_workspace_attachment',
    category: 'Gmail/Messages',
    description: `Upload a new attachment to local storage for a Gmail message or Calendar event. Provide base64-encoded file content.`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the workspace account'
        },
        source: {
          type: 'string',
          enum: ['email', 'calendar'],
          description: 'Source type (email or calendar)'
        },
        message_id: {
          type: 'string',
          description: 'ID of the email/event for the attachment'
        },
        filename: {
          type: 'string',
          description: 'Name of the attachment file'
        },
        mime_type: {
          type: 'string',
          description: 'MIME type of the file (e.g., application/pdf)'
        },
        content: {
          type: 'string',
          description: 'Base64 encoded file content'
        }
      },
      required: ['source', 'message_id', 'filename', 'content']
    }
  },
  {
    name: 'delete_workspace_attachment',
    category: 'Gmail/Messages',
    description: `Delete an attachment from local storage. The attachment must have been previously downloaded. This action cannot be undone.`,
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the workspace account'
        },
        source: {
          type: 'string',
          enum: ['email', 'calendar'],
          description: 'Source type (email or calendar)'
        },
        message_id: {
          type: 'string',
          description: 'ID of the email/event containing the attachment'
        },
        filename: {
          type: 'string',
          description: 'Name of the attachment to delete'
        }
      },
      required: ['source', 'message_id', 'filename']
    }
  },
  {
    name: 'manage_workspace_attachment',
    category: 'Gmail/Messages',
    description: `Legacy consolidated attachment tool. Prefer download_workspace_attachment, upload_workspace_attachment, or delete_workspace_attachment for new calls.`,
    aliases: ['manage_attachment'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address of the workspace account' },
        action: { type: 'string', enum: ['download', 'upload', 'delete'], description: 'Attachment action to perform' },
        source: { type: 'string', enum: ['email', 'calendar'], description: 'Source type' },
        message_id: { type: 'string', description: 'ID of the email/event containing the attachment' },
        filename: { type: 'string', description: 'Attachment filename' },
        mime_type: { type: 'string', description: 'MIME type for upload' },
        content: { type: 'string', description: 'Base64 content for upload' }
      },
      required: ['action', 'source', 'message_id', 'filename']
    }
  },
  {
    name: 'search_workspace_emails',
    category: 'Gmail/Messages',
    description: `Search emails. Example: { "query": "from:alice subject:meeting has:attachment", "max_results": 10 }

Gmail query syntax: from:, to:, subject:, has:attachment, is:unread, after:YYYY-MM-DD, before:YYYY-MM-DD, label:

Use get_workspace_email_thread with a thread_id from results to get full conversation.`,
    aliases: ['search_emails', 'find_emails', 'query_emails'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        // Account (optional for single-account setups)
        email: {
          type: 'string',
          description: 'Gmail account email (optional if only one account connected)'
        },
        
        // PRIMARY: Flat parameters (snake_case per MCP convention)
        query: {
          type: 'string',
          description: 'Gmail search query (e.g., "from:alice subject:meeting has:attachment newer_than:7d")'
        },
        max_results: {
          type: 'number',
          description: 'Maximum emails to return (default: 10, max: 100)'
        },
        
        // COMMON FILTERS: Flat for ease of use
        from: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } }
          ],
          description: 'Filter by sender email or name'
        },
        to: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } }
          ],
          description: 'Filter by recipient email'
        },
        subject: {
          type: 'string',
          description: 'Filter by subject text'
        },
        after: {
          type: 'string',
          description: 'Emails after date (YYYY-MM-DD)'
        },
        before: {
          type: 'string',
          description: 'Emails before date (YYYY-MM-DD)'
        },
        has_attachment: {
          type: 'boolean',
          description: 'Filter emails with attachments'
        },
        is_unread: {
          type: 'boolean',
          description: 'Filter by read/unread status'
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by labels (e.g., INBOX, SENT, IMPORTANT)'
        },
        
        // ADDITIONAL OPTIONS (flat)
        page_token: {
          type: 'string',
          description: 'Pagination token from previous response'
        },
        include_body: {
          type: 'boolean',
          description: 'Include full email body (default: false, returns snippet only)'
        },
        return_json: {
          type: 'boolean',
          description: 'Return JSON instead of formatted text (default: false)'
        },
        
        // LEGACY: Nested objects (backwards compatible, not recommended)
        search: {
          type: 'object',
          description: 'Legacy: Nested search object. Prefer flat parameters above.',
          properties: {
            from: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: 'Search by sender email address(es)'
            },
            to: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: 'Search by recipient email address(es)'
            },
            subject: {
              type: 'string',
              description: 'Search in email subject lines'
            },
            content: {
              type: 'string',
              description: 'Raw Gmail query string'
            },
            after: {
              type: 'string',
              description: 'Search emails after this date (YYYY-MM-DD)'
            },
            before: {
              type: 'string',
              description: 'Search emails before this date (YYYY-MM-DD)'
            },
            has_attachment: {
              type: 'boolean',
              description: 'Filter emails with attachments'
            },
            labels: {
              type: 'array',
              items: { type: 'string' },
              description: 'Include emails with these labels (e.g., INBOX, SENT, IMPORTANT)'
            },
            excludeLabels: {
              type: 'array',
              items: { type: 'string' },
              description: 'Exclude emails with these labels'
            },
            includeSpam: {
              type: 'boolean',
              description: 'Include emails from spam/trash folders'
            },
            is_unread: {
              type: 'boolean',
              description: 'Filter by read/unread status'
            }
          }
        },
        options: {
          type: 'object',
          description: 'Legacy: Nested options object. Prefer flat parameters above.',
          properties: {
            maxResults: {
              type: 'number',
              description: 'Maximum number of emails to return (default: 10)'
            },
            page_token: {
              type: 'string',
              description: 'Token for pagination'
            },
            format: {
              type: 'string',
              enum: ['minimal', 'metadata', 'full'],
              description: 'Amount of detail to return'
            },
            include_body: {
              type: 'boolean',
              description: 'Include full email body'
            },
            threadedView: {
              type: 'boolean',
              description: 'Group results by thread'
            },
            sortOrder: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: 'Sort order'
            },
            includeHeaders: {
              type: 'boolean',
              description: 'Include full email headers'
            }
          }
        }
      },
      required: []
    }
  },
  {
    name: 'get_workspace_email_thread',
    category: 'Gmail/Messages',
    description: `Get all messages in an email thread/conversation.

    Use this tool when you need to see the full context of an email conversation,
    including all replies and the original message.

    Use search_workspace_emails to FIND emails, then use this tool to get full thread context.

    Supports pagination for long threads: use offset + max_messages to page through.
    Example: first page { max_messages: 30 }, second page { offset: 30, max_messages: 30 }.

    Returns messages in chronological order (oldest first) with:
    - Full headers (from, to, cc, date, subject)
    - Body content (plain text preferred, HTML fallback)
    - Attachment metadata
    - Pagination info (hasMore, nextOffset) when offset is used

    Body summarization (default behaviour):
    By default, only the LAST 2 messages return their full body to keep long
    threads compact. Earlier messages return their snippet/preview only.
    Set include_full_bodies: true to get every message's full body (use for
    audit/forensic reads of older messages — costs more tokens). Set
    include_body: false to skip bodies entirely and return thread structure only.

    This is a read-only operation.`,
    aliases: ['get_thread', 'read_thread', 'get_conversation'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        thread_id: {
          type: 'string',
          description: 'Thread ID (from search results or message)'
        },
        max_messages: {
          type: 'number',
          description: 'Maximum messages to return (default: 50, for very long threads)'
        },
        offset: {
          type: 'number',
          description: 'Skip this many messages from the start (default: 0). Use with max_messages for pagination.'
        },
        include_body: {
          type: 'boolean',
          description: 'Include message bodies (default: true). Set false for thread structure only.'
        },
        include_full_bodies: {
          type: 'boolean',
          description: 'Return the full body of every message (default: false). When false, only the last 2 messages return their full body; earlier messages return their snippet/preview only. Set true for audit/forensic reads of older messages.'
        },
        return_json: {
          type: 'boolean',
          description: 'Return structured JSON instead of formatted text (default: false)'
        }
      },
      required: ['thread_id']
    }
  },
  {
    name: 'compose_workspace_email',
    category: 'Gmail/Messages',
    description: `Open an inline editable email compose form before sending.

Use this when the user wants an editable review form in Rebel before sending. The form lets the user edit To, CC, BCC, Subject, and Body, then explicitly click Send.

Do NOT use this when the user asks to save/create a Gmail draft, save to drafts, or save the already-drafted email without opening another review UI. Use create_workspace_draft for that.

This tool does not send the email directly. It prepares the draft and launches the inline form.`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address to send from'
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of recipient email addresses'
        },
        cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of CC recipient email addresses'
        },
        bcc: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of BCC recipient email addresses'
        },
        subject: {
          type: 'string',
          description: 'Email subject'
        },
        body: {
          type: 'string',
          description: 'Email body content (plain text for compose form prefill)'
        }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'send_workspace_email',
    category: 'Gmail/Messages',
    description: `Send an email from a Gmail account.

TIP: If you are drafting an email for the user to review before sending, prefer compose_workspace_email — it opens an inline editable form so the user can edit and send themselves.

CRITICAL - PLAIN TEXT vs HTML:
- Default is PLAIN TEXT (is_html: false). Use for most emails.
- ONLY use is_html: true when you need formatting like bold, links, or lists.
- If is_html: true, body MUST be valid HTML (wrap in tags, use <br> for line breaks).
- If is_html: false (default), body is plain text (line breaks work naturally).

PLAIN TEXT (default - use this most of the time):
{ "to": ["alice@example.com"], "subject": "Quick question", "body": "Hi Alice,\\n\\nCan we meet tomorrow at 3pm?\\n\\nThanks,\\nBob" }

HTML (only when formatting is needed):
{ "to": ["alice@example.com"], "subject": "Meeting Summary", "body": "<p>Hi Alice,</p><p>Key points from our meeting:</p><ul><li>Budget approved</li><li>Launch date: March 1st</li></ul><p>Thanks,<br>Bob</p>", "is_html": true }

COMMON MISTAKES TO AVOID:
- Don't include HTML tags without setting is_html: true (they'll show as raw text)
- Don't set is_html: true for plain messages (unnecessary complexity)
- Don't forget <br> or <p> tags for line breaks in HTML mode

REPLY TO EXISTING EMAIL:
{ "to": ["original-sender@example.com"], "subject": "Re: Meeting Tomorrow", "body": "Sounds good!\\n\\nOn Mon, Jan 6, 2026 at 10:00 AM, Alice <alice@example.com> wrote:\\n> Hey, are we still on for tomorrow's meeting?\\n> Let me know if the time works.", "reply_to_message_id": "18c5a2b3d4e5f6g7" }

IMPORTANT: For replies, use reply_to_message_id with the Gmail message ID. This auto-sets threading headers.
You MUST include quoted previous messages in the body — the threading headers alone do not include prior message content. Many recipients use non-threaded email clients or see the message in notifications without thread context. Use get_workspace_email_thread first to fetch the conversation, then include the prior messages with conventional quoting (plain text: "> " prefix with "On DATE, SENDER wrote:" header; HTML: <blockquote> tags).

FORWARD AN EMAIL:
{ "to": ["bob@example.com"], "subject": "Fwd: Meeting Tomorrow", "body": "FYI see below.\\n\\n---------- Forwarded message ----------\\nFrom: Alice <alice@example.com>\\nDate: Mon, Jan 6, 2026\\nSubject: Meeting Tomorrow\\nTo: You <you@example.com>\\n\\nHey, are we still on for tomorrow's meeting?" }

For forwards, include the full original message with a forwarded message header block.

IMPORTANT - FORWARDING WITH ATTACHMENTS:
When the original email has attachments, you MUST download and re-attach them:
1. Use get_workspace_email_thread to see which attachments exist (filenames listed per message)
2. Use download_workspace_attachment for each attachment (source: "email", message_id, filename)
3. Include them in the "attachments" array using the local file path returned by the download
Example: { "to": ["bob@example.com"], "subject": "Fwd: Report", "body": "See attached.\\n\\n---------- Forwarded message ----------\\n...", "attachments": [{ "path": "/path/to/downloaded/report.pdf" }] }
Attachments are NOT automatically carried over — you must explicitly download and re-attach them.`,
    aliases: ['send_email', 'send_mail', 'create_email'],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address to send from'
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of recipient email addresses'
        },
        subject: {
          type: 'string',
          description: 'Email subject (for replies, should match original with "Re: " prefix)'
        },
        body: {
          type: 'string',
          description: 'Email body content'
        },
        is_html: {
          type: 'boolean',
          description: 'Set true ONLY if body contains HTML tags (<p>, <ul>, <b>, etc.). Default: false (plain text). Most emails should NOT use this.'
        },
        cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of CC recipient email addresses'
        },
        bcc: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of BCC recipient email addresses'
        },
        reply_to_message_id: {
          type: 'string',
          description: 'Gmail message ID to reply to. Automatically sets threading headers (In-Reply-To, References, thread_id). Subject should match the original.'
        },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique attachment ID (auto-generated from filename if using path)' },
              name: { type: 'string', description: 'Filename (auto-detected from path if not provided)' },
              mimeType: { type: 'string', description: 'MIME type (auto-detected from path if not provided)' },
              size: { type: 'number', description: 'Size in bytes (auto-detected from path if not provided)' },
              content: { type: 'string', description: 'Base64-encoded file content (not needed if path is provided)' },
              path: { type: 'string', description: 'Local file path — alternative to content. Server reads and encodes the file automatically. All other fields are auto-detected from the file.' }
            },
            required: []
          },
          description: 'Attachments. Provide either "path" (preferred for local files) or "content" (base64). When using path, name/mimeType/size are auto-detected.'
        }
      },
      required: ['to', 'subject', 'body']
    }
  },
  // --- Gmail Quick Action tools ---

  {
    name: 'archive_workspace_email',
    category: 'Gmail/Messages',
    description: `Archive a Gmail message (remove it from the Inbox). The message remains accessible via search and labels.

    Supports batch: provide either a single message_id or an array of message_ids.

    Note: This operates on individual messages, not entire threads.

    Examples:
    1. Archive one message:  { "message_id": "18c5a2b3d4e5f6g7" }
    2. Archive multiple:     { "message_ids": ["18c5a2b3d4e5f6g7", "18c5a2b3d4e5f6g8"] }`,
    aliases: ['archive_email'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        message_id: {
          type: 'string',
          description: 'ID of the message to archive'
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of message IDs to archive (for batch operations)'
        }
      },
      required: []
    }
  },
  {
    name: 'trash_workspace_email',
    category: 'Gmail/Messages',
    description: `Move a Gmail message to the trash. Trashed messages are permanently deleted after 30 days.

    Supports batch: provide either a single message_id or an array of message_ids.

    Note: This operates on individual messages, not entire threads. Use untrash_workspace_email to restore.

    Examples:
    1. Trash one message:  { "message_id": "18c5a2b3d4e5f6g7" }
    2. Trash multiple:     { "message_ids": ["18c5a2b3d4e5f6g7", "18c5a2b3d4e5f6g8"] }`,
    aliases: ['trash_email', 'delete_email'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        message_id: {
          type: 'string',
          description: 'ID of the message to trash'
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of message IDs to trash (for batch operations)'
        }
      },
      required: []
    }
  },
  {
    name: 'untrash_workspace_email',
    category: 'Gmail/Messages',
    description: `Restore a Gmail message from the trash. The message returns to its previous location.

    Supports batch: provide either a single message_id or an array of message_ids.

    Note: This operates on individual messages, not entire threads.

    Examples:
    1. Restore one message:  { "message_id": "18c5a2b3d4e5f6g7" }
    2. Restore multiple:     { "message_ids": ["18c5a2b3d4e5f6g7", "18c5a2b3d4e5f6g8"] }`,
    aliases: ['untrash_email', 'restore_email'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        message_id: {
          type: 'string',
          description: 'ID of the message to restore from trash'
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of message IDs to restore (for batch operations)'
        }
      },
      required: []
    }
  },
  {
    name: 'mark_workspace_email_read',
    category: 'Gmail/Messages',
    description: `Mark a Gmail message as read.

    Supports batch: provide either a single message_id or an array of message_ids.

    Note: This operates on individual messages, not entire threads.

    Examples:
    1. Mark one as read:  { "message_id": "18c5a2b3d4e5f6g7" }
    2. Mark multiple:     { "message_ids": ["18c5a2b3d4e5f6g7", "18c5a2b3d4e5f6g8"] }`,
    aliases: ['mark_read', 'mark_email_read'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        message_id: {
          type: 'string',
          description: 'ID of the message to mark as read'
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of message IDs to mark as read (for batch operations)'
        }
      },
      required: []
    }
  },
  {
    name: 'mark_workspace_email_unread',
    category: 'Gmail/Messages',
    description: `Mark a Gmail message as unread.

    Supports batch: provide either a single message_id or an array of message_ids.

    Note: This operates on individual messages, not entire threads.

    Examples:
    1. Mark one as unread:  { "message_id": "18c5a2b3d4e5f6g7" }
    2. Mark multiple:       { "message_ids": ["18c5a2b3d4e5f6g7", "18c5a2b3d4e5f6g8"] }`,
    aliases: ['mark_unread', 'mark_email_unread'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        message_id: {
          type: 'string',
          description: 'ID of the message to mark as unread'
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of message IDs to mark as unread (for batch operations)'
        }
      },
      required: []
    }
  },

  {
    name: 'get_workspace_gmail_settings',
    category: 'Gmail/Settings',
    description: `Get Gmail settings and profile information for a workspace account.
    
    IMPORTANT: Always verify account access first with list_workspace_accounts.
    
    Common Uses:
    - Check account configuration
    - Verify email settings
    - Access profile information
    
    Response includes:
    - Language settings
    - Signature settings
    - Vacation responder status
    - Filters and forwarding
    - Other account preferences`,
    aliases: ['get_gmail_settings', 'gmail_settings', 'get_mail_settings'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        }
      },
      required: []
    }
  },
  // --- Individual draft tools (replaced legacy manage_workspace_draft) ---

  {
    name: 'list_workspace_drafts',
    category: 'Gmail/Drafts',
    description: `List all Gmail drafts for the account. Returns draft IDs and message snippets for each draft.`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        }
      },
      required: []
    }
  },
  {
    name: 'get_workspace_draft',
    category: 'Gmail/Drafts',
    description: `Get a specific Gmail draft by ID. Returns the full draft content including recipients, subject, body, and attachments.`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        draft_id: {
          type: 'string',
          description: 'ID of the draft to retrieve'
        }
      },
      required: ['draft_id']
    }
  },
  {
    name: 'create_workspace_draft',
    category: 'Gmail/Drafts',
    description: `Create a new Gmail draft. Use this when the user asks to save to drafts, save/create a Gmail draft, or save an already-drafted email without sending or opening another review UI. Supports plain text and HTML bodies, CC/BCC, reply threading, and attachments.`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of recipient email addresses'
        },
        subject: {
          type: 'string',
          description: 'Email subject'
        },
        body: {
          type: 'string',
          description: 'Email body content. Plain text by default — use \\n for line breaks. If you need HTML formatting (bold, lists, links), you MUST also set is_html: true or HTML tags will show as raw text in Gmail.'
        },
        is_html: {
          type: 'boolean',
          description: 'Set true ONLY if body contains HTML tags (<p>, <ul>, <b>, etc.). Default: false (plain text). WARNING: If body contains HTML tags but is_html is false, tags will show as raw text in Gmail. Most drafts should use plain text.'
        },
        cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of CC recipient email addresses'
        },
        bcc: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of BCC recipient email addresses'
        },
        reply_to_message_id: {
          type: 'string',
          description: 'Message ID to reply to (for creating reply drafts)'
        },
        thread_id: {
          type: 'string',
          description: 'Thread ID for the email (optional for replies)'
        },
        in_reply_to: {
          type: 'string',
          description: 'Message ID being replied to (for email threading)'
        },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: 'Reference message IDs for email threading'
        },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique attachment ID (auto-generated from filename if using path)' },
              name: { type: 'string', description: 'Filename (auto-detected from path if not provided)' },
              mimeType: { type: 'string', description: 'MIME type (auto-detected from path if not provided)' },
              size: { type: 'number', description: 'Size in bytes (auto-detected from path if not provided)' },
              content: { type: 'string', description: 'Base64-encoded file content (not needed if path is provided)' },
              path: { type: 'string', description: 'Local file path — alternative to content. Server reads and encodes the file automatically. All other fields are auto-detected from the file.' }
            },
            required: []
          },
          description: 'Attachments. Provide either "path" (preferred for local files) or "content" (base64). When using path, name/mimeType/size are auto-detected.'
        }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'update_workspace_draft',
    category: 'Gmail/Drafts',
    description: `Update an existing Gmail draft. Replaces the draft content with the provided fields. Supports attachments and reply threading.`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        draft_id: {
          type: 'string',
          description: 'ID of the draft to update'
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of recipient email addresses'
        },
        subject: {
          type: 'string',
          description: 'Email subject'
        },
        body: {
          type: 'string',
          description: 'Email body content. Plain text by default — use \\n for line breaks. If you need HTML formatting (bold, lists, links), you MUST also set is_html: true or HTML tags will show as raw text in Gmail.'
        },
        is_html: {
          type: 'boolean',
          description: 'Set true ONLY if body contains HTML tags (<p>, <ul>, <b>, etc.). Default: false (plain text). WARNING: If body contains HTML tags but is_html is false, tags will show as raw text in Gmail. Most drafts should use plain text.'
        },
        cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of CC recipient email addresses'
        },
        bcc: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of BCC recipient email addresses'
        },
        reply_to_message_id: {
          type: 'string',
          description: 'Message ID to reply to (for creating reply drafts)'
        },
        thread_id: {
          type: 'string',
          description: 'Thread ID for the email (optional for replies)'
        },
        in_reply_to: {
          type: 'string',
          description: 'Message ID being replied to (for email threading)'
        },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: 'Reference message IDs for email threading'
        },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique attachment ID (auto-generated from filename if using path)' },
              name: { type: 'string', description: 'Filename (auto-detected from path if not provided)' },
              mimeType: { type: 'string', description: 'MIME type (auto-detected from path if not provided)' },
              size: { type: 'number', description: 'Size in bytes (auto-detected from path if not provided)' },
              content: { type: 'string', description: 'Base64-encoded file content (not needed if path is provided)' },
              path: { type: 'string', description: 'Local file path — alternative to content. Server reads and encodes the file automatically. All other fields are auto-detected from the file.' }
            },
            required: []
          },
          description: 'Attachments. Provide either "path" (preferred for local files) or "content" (base64). When using path, name/mimeType/size are auto-detected.'
        }
      },
      required: ['draft_id', 'to', 'subject', 'body']
    }
  },
  {
    name: 'delete_workspace_draft',
    category: 'Gmail/Drafts',
    description: `Delete a Gmail draft permanently. This action cannot be undone.`,
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        draft_id: {
          type: 'string',
          description: 'ID of the draft to delete'
        }
      },
      required: ['draft_id']
    }
  },
  {
    name: 'send_workspace_draft',
    category: 'Gmail/Drafts',
    description: `Send an existing Gmail draft as an email. The draft will be removed from drafts after sending.`,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Gmail account'
        },
        draft_id: {
          type: 'string',
          description: 'ID of the draft to send'
        }
      },
      required: ['draft_id']
    }
  },
  {
    name: 'manage_workspace_draft',
    category: 'Gmail/Drafts',
    description: `Legacy consolidated draft tool. Prefer the individual draft tools for new calls.`,
    aliases: ['manage_draft'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address of the Gmail account' },
        action: { type: 'string', enum: ['create', 'list', 'get', 'update', 'delete', 'send'], description: 'Draft action to perform' },
        draft_id: { type: 'string', description: 'Draft ID for get/update/delete/send' },
        to: { type: 'array', items: { type: 'string' }, description: 'Recipients for create/update' },
        subject: { type: 'string', description: 'Email subject for create/update' },
        body: { type: 'string', description: 'Email body for create/update' }
      },
      required: ['action']
    }
  }
];
