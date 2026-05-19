import { ToolMetadata } from "../../modules/tools/registry.js";

export const commentsTools: ToolMetadata[] = [
  {
    name: 'list_workspace_comments',
    category: 'Drive/Comments',
    description: `List comments on a Google Drive file (Docs, Sheets, Slides, PDFs, etc.).

    Returns all comments with their replies, author info, and resolved status.
    Works on any file in Google Drive, not just documents.

    Usage examples:

    1. List comments on a file:
       { "email": "user@example.com", "file_id": "1ABC123xyz" }

    2. With pagination:
       { "email": "user@example.com", "file_id": "1ABC123xyz", "page_size": 50 }

    3. Include deleted comments:
       { "email": "user@example.com", "file_id": "1ABC123xyz", "include_deleted": true }`,
    aliases: ['list_comments', 'get_comments'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account',
        },
        file_id: {
          type: 'string',
          description: 'Google Drive file ID (from URL or Drive listing)',
        },
        page_size: {
          type: 'number',
          description: 'Number of comments to return per page (default: 20, max: 100)',
        },
        page_token: {
          type: 'string',
          description: 'Token for fetching the next page of results',
        },
        include_deleted: {
          type: 'boolean',
          description: 'Whether to include deleted comments (default: false)',
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'create_workspace_comment',
    category: 'Drive/Comments',
    description: `Create a new comment on a Google Drive file.

    Adds a comment visible to all collaborators on the file.

    Usage examples:

    1. Simple comment:
       { "email": "user@example.com", "file_id": "1ABC123xyz", "content": "This section needs revision." }

    2. With quoted content (highlights text in Docs):
       {
         "email": "user@example.com",
         "file_id": "1ABC123xyz",
         "content": "Should this be updated?",
         "quoted_file_content": { "mimeType": "text/html", "value": "the text to highlight" }
       }`,
    aliases: ['add_comment', 'comment_on_file'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account',
        },
        file_id: {
          type: 'string',
          description: 'Google Drive file ID',
        },
        content: {
          type: 'string',
          description: 'The text content of the comment',
        },
        anchor: {
          type: 'string',
          description: 'File-type-specific JSON anchor for positioning the comment (advanced)',
        },
        quoted_file_content: {
          type: 'object',
          description: 'Content from the file that the comment refers to (used for highlighting)',
          properties: {
            mimeType: { type: 'string', description: 'MIME type (usually "text/html")' },
            value: { type: 'string', description: 'The quoted text from the file' },
          },
          required: ['mimeType', 'value'],
        },
      },
      required: ['file_id', 'content'],
    },
  },
  {
    name: 'resolve_workspace_comment',
    category: 'Drive/Comments',
    description: `Resolve or reopen a comment on a Google Drive file.

    Resolving marks a comment thread as done. Reopening brings it back for discussion.

    Usage examples:

    1. Resolve a comment:
       { "email": "user@example.com", "file_id": "1ABC123xyz", "comment_id": "AAAA", "action": "resolve" }

    2. Reopen a resolved comment:
       { "email": "user@example.com", "file_id": "1ABC123xyz", "comment_id": "AAAA", "action": "reopen" }`,
    aliases: ['resolve_comment', 'close_comment'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account',
        },
        file_id: {
          type: 'string',
          description: 'Google Drive file ID',
        },
        comment_id: {
          type: 'string',
          description: 'ID of the comment to resolve/reopen',
        },
        action: {
          type: 'string',
          enum: ['resolve', 'reopen'],
          description: 'Action to perform: "resolve" to mark as done, "reopen" to bring back for discussion',
        },
      },
      required: ['file_id', 'comment_id', 'action'],
    },
  },
  {
    name: 'reply_to_workspace_comment',
    category: 'Drive/Comments',
    description: `Reply to an existing comment on a Google Drive file.

    Adds a reply to a comment thread, visible to all collaborators.

    Usage example:
    { "email": "user@example.com", "file_id": "1ABC123xyz", "comment_id": "AAAA", "content": "Good point, I will fix this." }`,
    aliases: ['reply_comment', 'comment_reply'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account',
        },
        file_id: {
          type: 'string',
          description: 'Google Drive file ID',
        },
        comment_id: {
          type: 'string',
          description: 'ID of the comment to reply to',
        },
        content: {
          type: 'string',
          description: 'The text content of the reply',
        },
      },
      required: ['file_id', 'comment_id', 'content'],
    },
  },
  {
    name: 'delete_workspace_comment',
    category: 'Drive/Comments',
    description: `Delete a comment from a Google Drive file.

    Only the comment author can delete their own comments.

    Usage example:
    { "email": "user@example.com", "file_id": "1ABC123xyz", "comment_id": "AAAA" }`,
    aliases: ['remove_comment'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account',
        },
        file_id: {
          type: 'string',
          description: 'Google Drive file ID',
        },
        comment_id: {
          type: 'string',
          description: 'ID of the comment to delete',
        },
      },
      required: ['file_id', 'comment_id'],
    },
  },
];
