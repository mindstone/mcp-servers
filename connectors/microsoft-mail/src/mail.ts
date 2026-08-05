import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Client, EmailMessage, MailFolder } from '@mindstone/mcp-server-microsoft-shared';
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

// Graph response payloads are cast by the SDK; the tools added here validate
// the fields they consume with Zod at the boundary (planned tightening —
// pre-existing read tools still cast, tracked in the CHANGELOG).
const GraphAttachmentSchema = z
  .object({
    '@odata.type': z.string().optional(),
    id: z.string(),
    name: z.string().optional(),
    contentType: z.string().optional(),
    size: z.number().optional(),
    isInline: z.boolean().optional(),
    contentBytes: z.string().optional(),
  })
  .passthrough();

const GraphAttachmentListSchema = z
  .object({ value: z.array(GraphAttachmentSchema).default([]) })
  .passthrough();

const GraphMessageMutationSchema = z
  .object({
    id: z.string(),
    subject: z.string().optional(),
    conversationId: z.string().optional(),
    isDraft: z.boolean().optional(),
    isRead: z.boolean().optional(),
    flag: z.object({ flagStatus: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const GraphConversationIdSchema = z
  .object({ conversationId: z.string() })
  .passthrough();

const GraphConversationMessageSchema = z
  .object({
    id: z.string(),
    subject: z.string().optional(),
    from: z
      .object({
        emailAddress: z
          .object({ address: z.string().optional(), name: z.string().optional() })
          .passthrough(),
      })
      .passthrough()
      .optional(),
    receivedDateTime: z.string().optional(),
    bodyPreview: z.string().optional(),
    isRead: z.boolean().optional(),
    hasAttachments: z.boolean().optional(),
  })
  .passthrough();

const GraphConversationListSchema = z
  .object({ value: z.array(GraphConversationMessageSchema).default([]) })
  .passthrough();

const WELL_KNOWN_FOLDERS: Record<string, string> = {
  inbox: 'inbox',
  'sent items': 'sentitems',
  sent: 'sentitems',
  'deleted items': 'deleteditems',
  trash: 'deleteditems',
  'junk email': 'junkemail',
  junk: 'junkemail',
  spam: 'junkemail',
  drafts: 'drafts',
  archive: 'archive',
  outbox: 'outbox',
};

export function resolveFolder(folder: string): string {
  const trimmed = folder.trim();
  return WELL_KNOWN_FOLDERS[trimmed.toLowerCase()] ?? trimmed;
}

function ensureArray(value: string | string[] | undefined): string[] | undefined {
  if (value == null) return undefined;
  return Array.isArray(value) ? value : [value];
}

export interface ListEmailsArgs {
  folder?: string;
  top?: number;
  filter?: string;
}

export async function listEmails(
  client: Client,
  args: ListEmailsArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const folder = resolveFolder(args.folder ?? 'Inbox');
  const top = Math.min(args.top ?? 25, 100);

  let endpoint = `/me/mailFolders/${folder}/messages`;
  const queryParams: string[] = [
    `$top=${top}`,
    '$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,importance',
    '$orderby=receivedDateTime desc',
  ];

  if (args.filter) {
    queryParams.push(`$filter=${args.filter}`);
  }

  endpoint += '?' + queryParams.join('&');

  const response = await client.api(endpoint).options({ signal }).get();
  const emails: EmailMessage[] = response.value ?? [];

  const formatted = emails.map((email) => ({
    id: email.id,
    subject: wrapUntrusted(email.subject, 'microsoft-mail:list_emails:subject'),
    from: wrapUntrusted(email.from?.emailAddress?.address, 'microsoft-mail:list_emails:from'),
    fromName: wrapUntrusted(email.from?.emailAddress?.name, 'microsoft-mail:list_emails:fromName'),
    receivedAt: email.receivedDateTime,
    preview: wrapUntrusted(email.bodyPreview?.substring(0, 200), 'microsoft-mail:list_emails:preview'),
    isRead: email.isRead,
    hasAttachments: email.hasAttachments,
    importance: email.importance,
  }));

  return {
    count: formatted.length,
    folder,
    emails: formatted,
  };
}

export interface GetEmailArgs {
  id: string;
}

export async function getEmail(
  client: Client,
  args: GetEmailArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const email = await client
    .api(`/me/messages/${args.id}`)
    .options({ signal })
    .select('id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,hasAttachments,importance')
    .get();

  return {
    id: email.id,
    subject: wrapUntrusted(email.subject, 'microsoft-mail:get_email:subject'),
    from: wrapUntrustedJsonStrings(email.from?.emailAddress, 'microsoft-mail:get_email:from'),
    to: wrapUntrustedJsonStrings(
      email.toRecipients?.map((r: { emailAddress?: unknown }) => r.emailAddress),
      'microsoft-mail:get_email:to',
    ),
    cc: wrapUntrustedJsonStrings(
      email.ccRecipients?.map((r: { emailAddress?: unknown }) => r.emailAddress),
      'microsoft-mail:get_email:cc',
    ),
    receivedAt: email.receivedDateTime,
    body: wrapUntrusted(email.body?.content, 'microsoft-mail:get_email:body'),
    bodyType: email.body?.contentType,
    isRead: email.isRead,
    hasAttachments: email.hasAttachments,
    importance: email.importance,
  };
}

export interface SendEmailArgs {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  importance?: 'low' | 'normal' | 'high';
}

export async function sendEmail(
  client: Client,
  args: SendEmailArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const toList = ensureArray(args.to) ?? [];
  const ccList = ensureArray(args.cc);
  const bccList = ensureArray(args.bcc);

  const message = {
    subject: args.subject,
    body: {
      contentType: args.body.includes('<') ? 'HTML' : 'Text',
      content: args.body,
    },
    toRecipients: toList.map((email) => ({
      emailAddress: { address: email },
    })),
    ccRecipients: ccList?.map((email) => ({
      emailAddress: { address: email },
    })),
    bccRecipients: bccList?.map((email) => ({
      emailAddress: { address: email },
    })),
    importance: args.importance ?? 'normal',
  };

  await client.api('/me/sendMail').options({ signal }).post({ message });

  return {
    success: true,
    message: `Email sent to ${toList.join(', ')}`,
  };
}

export interface SearchEmailsArgs {
  query: string;
  top?: number;
}

export async function searchEmails(
  client: Client,
  args: SearchEmailsArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const top = Math.min(args.top ?? 25, 100);

  // Note: Microsoft Graph API does not support $orderBy with $search.
  // Search results are automatically sorted by date (newest first).
  const response = await client
    .api('/me/messages')
    .options({ signal })
    .search(`"${args.query}"`)
    .top(top)
    .select('id,subject,from,receivedDateTime,bodyPreview,isRead')
    .get();

  const emails: EmailMessage[] = response.value ?? [];

  const formatted = emails.map((email) => ({
    id: email.id,
    subject: wrapUntrusted(email.subject, 'microsoft-mail:search_emails:subject'),
    from: wrapUntrusted(email.from?.emailAddress?.address, 'microsoft-mail:search_emails:from'),
    receivedAt: email.receivedDateTime,
    preview: wrapUntrusted(email.bodyPreview?.substring(0, 200), 'microsoft-mail:search_emails:preview'),
    isRead: email.isRead,
  }));

  return {
    query: args.query,
    count: formatted.length,
    emails: formatted,
  };
}

export interface ReplyToEmailArgs {
  id: string;
  body: string;
  replyAll?: boolean;
}

export async function replyToEmail(
  client: Client,
  args: ReplyToEmailArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = args.replyAll
    ? `/me/messages/${args.id}/replyAll`
    : `/me/messages/${args.id}/reply`;

  await client.api(endpoint).options({ signal }).post({
    comment: args.body,
  });

  return {
    success: true,
    message: args.replyAll ? 'Reply sent to all recipients' : 'Reply sent',
  };
}

export interface ForwardEmailArgs {
  id: string;
  to: string | string[];
  comment?: string;
}

export async function forwardEmail(
  client: Client,
  args: ForwardEmailArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const toList = ensureArray(args.to) ?? [];

  await client.api(`/me/messages/${args.id}/forward`).options({ signal }).post({
    comment: args.comment ?? '',
    toRecipients: toList.map((email) => ({
      emailAddress: { address: email },
    })),
  });

  return {
    success: true,
    message: `Email forwarded to ${toList.join(', ')}`,
  };
}

export interface DeleteEmailArgs {
  id: string;
  permanent?: boolean;
}

export async function deleteEmail(
  client: Client,
  args: DeleteEmailArgs,
  signal: AbortSignal,
): Promise<unknown> {
  if (args.permanent) {
    await client.api(`/me/messages/${args.id}`).options({ signal }).delete();
    return { success: true, message: 'Email permanently deleted' };
  }

  await client.api(`/me/messages/${args.id}/move`).options({ signal }).post({
    destinationId: 'deleteditems',
  });

  return { success: true, message: 'Email moved to Deleted Items' };
}

export interface ListFoldersArgs {
  includeHidden?: boolean;
}

export async function listFolders(
  client: Client,
  args: ListFoldersArgs,
  signal: AbortSignal,
): Promise<unknown> {
  let endpoint = '/me/mailFolders';
  if (!args.includeHidden) {
    endpoint += '?$filter=isHidden eq false';
  }

  const response = await client.api(endpoint).options({ signal }).get();
  const folders: MailFolder[] = response.value ?? [];

  const formatted = folders.map((folder) => ({
    id: folder.id,
    name: wrapUntrusted(folder.displayName, 'microsoft-mail:list_folders:name'),
    totalItems: folder.totalItemCount,
    unreadItems: folder.unreadItemCount,
    childFolders: folder.childFolderCount,
  }));

  return {
    count: formatted.length,
    folders: formatted,
  };
}

export interface MoveEmailArgs {
  id: string;
  destinationFolder: string;
}

export async function moveEmail(
  client: Client,
  args: MoveEmailArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const folderId = resolveFolder(args.destinationFolder);

  await client.api(`/me/messages/${args.id}/move`).options({ signal }).post({
    destinationId: folderId,
  });

  return {
    success: true,
    message: `Email moved to ${args.destinationFolder}`,
  };
}

export interface CreateReplyDraftArgs {
  id: string;
  body?: string;
  replyAll?: boolean;
}

export async function createReplyDraft(
  client: Client,
  args: CreateReplyDraftArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoint = args.replyAll
    ? `/me/messages/${args.id}/createReplyAll`
    : `/me/messages/${args.id}/createReply`;

  const requestBody: Record<string, unknown> = {};
  if (args.body) {
    requestBody.message = {
      body: {
        contentType: args.body.includes('<') ? 'HTML' : 'Text',
        content: args.body,
      },
    };
  }

  const response = await client.api(endpoint).options({ signal }).post(requestBody);

  return {
    success: true,
    draftId: response.id,
    conversationId: response.conversationId,
    subject: wrapUntrusted(response.subject, 'microsoft-mail:create_reply_draft:subject'),
    message: `Reply draft created${args.replyAll ? ' (reply-all)' : ''}. Open Outlook to review and send.`,
  };
}

export interface CreateDraftArgs {
  to?: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
}

export async function createDraft(
  client: Client,
  args: CreateDraftArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const toList = ensureArray(args.to);
  const ccList = ensureArray(args.cc);
  const bccList = ensureArray(args.bcc);

  const draft = {
    subject: args.subject,
    body: {
      contentType: args.body.includes('<') ? 'HTML' : 'Text',
      content: args.body,
    },
    toRecipients: toList?.map((email) => ({
      emailAddress: { address: email },
    })),
    ccRecipients: ccList?.map((email) => ({
      emailAddress: { address: email },
    })),
    bccRecipients: bccList?.map((email) => ({
      emailAddress: { address: email },
    })),
  };

  const response = await client.api('/me/messages').options({ signal }).post(draft);

  return {
    success: true,
    draftId: response.id,
    message: 'Draft created successfully',
  };
}

export interface ListAttachmentsArgs {
  id: string;
}

export async function listAttachments(
  client: Client,
  args: ListAttachmentsArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await client
    .api(`/me/messages/${args.id}/attachments`)
    .options({ signal })
    .get();
  const parsed = GraphAttachmentListSchema.parse(response);

  const attachments = parsed.value.map((attachment) => ({
    id: attachment.id,
    name: wrapUntrusted(attachment.name, 'microsoft-mail:list_attachments:name'),
    contentType: attachment.contentType,
    size: attachment.size,
    isInline: attachment.isInline,
    type: attachment['@odata.type']?.replace('#microsoft.graph.', ''),
  }));

  return {
    messageId: args.id,
    count: attachments.length,
    attachments,
  };
}

// Mail attachment bodies can be large; Graph inlines contentBytes on the
// single-attachment GET, so cap what we are willing to decode and write.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Reject anything that is not a plain filename before it is joined onto the
 * attachment directory (same rule family as the other file-writing
 * connectors: no separators, no `..`, no dotfiles, no NUL).
 */
function sanitizeAttachmentFilename(name: string): string {
  if (name.trim().length === 0) {
    throw new Error('Invalid attachment filename: must not be empty');
  }
  if (name.includes('\0')) {
    throw new Error('Invalid attachment filename: must not contain NUL bytes');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error('Invalid attachment filename: must not contain path separators');
  }
  if (name.includes('..')) {
    throw new Error(`Invalid attachment filename: must not contain '..'`);
  }
  if (name.startsWith('.')) {
    throw new Error('Invalid attachment filename: must not start with a dot');
  }
  const basename = path.basename(name);
  if (basename !== name || basename === '.' || basename === '..') {
    throw new Error('Invalid attachment filename: must be a plain filename');
  }
  return basename;
}

/**
 * Resolve the directory attachments are saved into, honouring the repo's
 * file-write invariant: canonical-prefix containment under
 * `MCP_WORKSPACE_PATH` (or `os.tmpdir()` when unset), with the canonical
 * (symlink-resolved) root as the containment anchor.
 */
async function resolveAttachmentDir(): Promise<string> {
  const root = process.env.MCP_WORKSPACE_PATH || os.tmpdir();
  const dir = path.join(root, 'attachments', 'microsoft-mail');
  await fs.mkdir(dir, { recursive: true });
  const realDir = await fs.realpath(dir);
  const relative = path.relative(await fs.realpath(root), realDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved attachment directory escaped its workspace root');
  }
  return realDir;
}

async function uniqueAttachmentPath(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? filename : `${base}-${attempt}${ext}`;
    const fullPath = path.join(dir, candidate);
    try {
      await fs.lstat(fullPath);
    } catch {
      return fullPath;
    }
  }
}

export interface DownloadAttachmentArgs {
  id: string;
  attachmentId: string;
}

export async function downloadAttachment(
  client: Client,
  args: DownloadAttachmentArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await client
    .api(`/me/messages/${args.id}/attachments/${args.attachmentId}`)
    .options({ signal })
    .get();
  const attachment = GraphAttachmentSchema.parse(response);

  if (attachment['@odata.type'] && !attachment['@odata.type'].endsWith('fileAttachment')) {
    throw new Error(
      `Attachment "${attachment.name ?? args.attachmentId}" is not a file attachment ` +
        `(${attachment['@odata.type'].replace('#microsoft.graph.', '')}); inline download is not ` +
        'supported for embedded-message or reference attachments. Open the message in Outlook to access it.',
    );
  }
  if (!attachment.contentBytes) {
    throw new Error(
      `Attachment "${attachment.name ?? args.attachmentId}" has no inline content. ` +
        'Open the message in Outlook to access it.',
    );
  }

  // ~4/3 expansion when decoding; reject before allocating the buffer.
  if (attachment.contentBytes.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3)) {
    throw new Error(
      `Attachment "${attachment.name ?? args.attachmentId}" exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB download limit.`,
    );
  }
  const content = Buffer.from(attachment.contentBytes, 'base64');
  if (content.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment "${attachment.name ?? args.attachmentId}" exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB download limit.`,
    );
  }

  const dir = await resolveAttachmentDir();
  const filename = sanitizeAttachmentFilename(attachment.name?.trim() || 'attachment');
  const fullPath = await uniqueAttachmentPath(dir, filename);
  // The filename is separator-free, but keep the canonical containment check
  // so a future refactor cannot silently weaken the boundary.
  const relative = path.relative(dir, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved attachment path escaped the attachment directory');
  }
  await fs.writeFile(fullPath, content);

  return {
    success: true,
    messageId: args.id,
    attachmentId: attachment.id,
    name: wrapUntrusted(attachment.name, 'microsoft-mail:download_attachment:name'),
    contentType: attachment.contentType,
    size: content.byteLength,
    savedTo: fullPath,
    message: `Attachment saved to ${fullPath}`,
  };
}

export interface SendDraftArgs {
  id: string;
}

export async function sendDraft(
  client: Client,
  args: SendDraftArgs,
  signal: AbortSignal,
): Promise<unknown> {
  await client.api(`/me/messages/${args.id}/send`).options({ signal }).post({});

  return {
    success: true,
    message: 'Draft sent',
  };
}

export interface UpdateDraftArgs {
  id: string;
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  body?: string;
  importance?: 'low' | 'normal' | 'high';
}

export async function updateDraft(
  client: Client,
  args: UpdateDraftArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const toList = ensureArray(args.to);
  const ccList = ensureArray(args.cc);

  const patch: Record<string, unknown> = {};
  if (args.subject !== undefined) patch.subject = args.subject;
  if (args.body !== undefined) {
    patch.body = {
      contentType: args.body.includes('<') ? 'HTML' : 'Text',
      content: args.body,
    };
  }
  if (toList !== undefined) {
    patch.toRecipients = toList.map((email) => ({ emailAddress: { address: email } }));
  }
  if (ccList !== undefined) {
    patch.ccRecipients = ccList.map((email) => ({ emailAddress: { address: email } }));
  }
  if (args.importance !== undefined) patch.importance = args.importance;

  const response = await client
    .api(`/me/messages/${args.id}`)
    .options({ signal })
    .patch(patch);
  const updated = GraphMessageMutationSchema.parse(response);

  return {
    success: true,
    draftId: updated.id,
    subject: wrapUntrusted(updated.subject, 'microsoft-mail:update_draft:subject'),
    message: 'Draft updated',
  };
}

export interface MarkEmailReadArgs {
  id: string;
  isRead?: boolean;
}

export async function markEmailRead(
  client: Client,
  args: MarkEmailReadArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const isRead = args.isRead ?? true;

  const response = await client
    .api(`/me/messages/${args.id}`)
    .options({ signal })
    .patch({ isRead });
  const updated = GraphMessageMutationSchema.parse(response);

  return {
    success: true,
    id: updated.id,
    isRead: updated.isRead ?? isRead,
    message: isRead ? 'Email marked as read' : 'Email marked as unread',
  };
}

export interface SetEmailFlagArgs {
  id: string;
  flag: 'flagged' | 'complete' | 'notFlagged';
}

export async function setEmailFlag(
  client: Client,
  args: SetEmailFlagArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await client
    .api(`/me/messages/${args.id}`)
    .options({ signal })
    .patch({ flag: { flagStatus: args.flag } });
  const updated = GraphMessageMutationSchema.parse(response);

  const messages: Record<SetEmailFlagArgs['flag'], string> = {
    flagged: 'Email flagged for follow-up',
    complete: 'Email follow-up flag marked complete',
    notFlagged: 'Email follow-up flag cleared',
  };

  return {
    success: true,
    id: updated.id,
    flag: updated.flag?.flagStatus ?? args.flag,
    message: messages[args.flag],
  };
}

export interface GetConversationArgs {
  id?: string;
  conversationId?: string;
  top?: number;
}

export async function getConversation(
  client: Client,
  args: GetConversationArgs,
  signal: AbortSignal,
): Promise<unknown> {
  let conversationId = args.conversationId;
  if (!conversationId && args.id) {
    const message = await client
      .api(`/me/messages/${args.id}`)
      .options({ signal })
      .select('conversationId')
      .get();
    conversationId = GraphConversationIdSchema.parse(message).conversationId;
  }
  if (!conversationId) {
    throw new Error('A message id or conversationId is required to load a conversation.');
  }
  // The conversation ID is embedded in an OData $filter literal; refuse values
  // that could break out of the quoted string.
  if (conversationId.includes("'")) {
    throw new Error('Invalid conversationId: must not contain single quotes.');
  }

  const top = Math.min(args.top ?? 25, 100);
  const endpoint =
    '/me/messages?' +
    [
      `$filter=conversationId eq '${conversationId}'`,
      '$orderby=receivedDateTime asc',
      `$top=${top}`,
      '$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments',
    ].join('&');

  const response = await client.api(endpoint).options({ signal }).get();
  const parsed = GraphConversationListSchema.parse(response);

  const formatted = parsed.value.map((email) => ({
    id: email.id,
    subject: wrapUntrusted(email.subject, 'microsoft-mail:get_conversation:subject'),
    from: wrapUntrusted(
      email.from?.emailAddress?.address,
      'microsoft-mail:get_conversation:from',
    ),
    fromName: wrapUntrusted(
      email.from?.emailAddress?.name,
      'microsoft-mail:get_conversation:fromName',
    ),
    receivedAt: email.receivedDateTime,
    preview: wrapUntrusted(
      email.bodyPreview?.substring(0, 200),
      'microsoft-mail:get_conversation:preview',
    ),
    isRead: email.isRead,
    hasAttachments: email.hasAttachments,
  }));

  return {
    conversationId,
    count: formatted.length,
    messages: formatted,
  };
}
