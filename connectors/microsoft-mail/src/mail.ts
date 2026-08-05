import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
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

const AutomaticRepliesSettingSchema = z
  .object({
    status: z.enum(['disabled', 'alwaysEnabled', 'scheduled']).optional(),
    externalAudience: z.enum(['none', 'contactsOnly', 'all']).optional(),
    internalReplyMessage: z.string().optional(),
    externalReplyMessage: z.string().optional(),
    scheduledStartDateTime: z
      .object({ dateTime: z.string(), timeZone: z.string().optional() })
      .passthrough()
      .optional(),
    scheduledEndDateTime: z
      .object({ dateTime: z.string(), timeZone: z.string().optional() })
      .passthrough()
      .optional(),
  })
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
  ];

  // Microsoft Graph rejects $filter combined with $orderby (HTTP 400
  // InefficientFilter), like the $search limitation noted in searchEmails.
  // With a filter present, results are sorted client-side below instead.
  if (args.filter) {
    queryParams.push(`$filter=${args.filter}`);
  } else {
    queryParams.push('$orderby=receivedDateTime desc');
  }

  endpoint += '?' + queryParams.join('&');

  const response = await client.api(endpoint).options({ signal }).get();
  const emails: EmailMessage[] = response.value ?? [];
  if (args.filter) {
    // Newest first, matching the $orderby the unfiltered path sends.
    emails.sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
  }

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
  const created = GraphMessageMutationSchema.parse(response);

  return {
    success: true,
    draftId: created.id,
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

// Mail attachment bodies can be large. The download path fetches metadata
// without contentBytes and streams the bytes from the $value endpoint with
// this hard cap, so an oversized response is cut off before it is fully
// materialized in memory.
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
 * (symlink-resolved) root as the containment anchor. The parent chain is
 * canonicalised before `mkdir` so a symlinked intermediate cannot trick the
 * connector into even creating a directory outside the workspace.
 */
async function resolveAttachmentDir(): Promise<string> {
  const root = process.env.MCP_WORKSPACE_PATH || os.tmpdir();
  const realRoot = await fs.realpath(root);
  const dir = path.join(realRoot, 'attachments', 'microsoft-mail');
  const parentReal = await fs
    .realpath(path.join(realRoot, 'attachments'))
    .catch(() => null);
  if (parentReal !== null) {
    const parentRelative = path.relative(realRoot, parentReal);
    if (parentRelative.startsWith('..') || path.isAbsolute(parentRelative)) {
      throw new Error('Resolved attachment directory escaped its workspace root');
    }
  }
  await fs.mkdir(dir, { recursive: true });
  const realDir = await fs.realpath(dir);
  const relative = path.relative(realRoot, realDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved attachment directory escaped its workspace root');
  }
  return realDir;
}

/**
 * Atomically create `dir/filename` and write `content` through the resulting
 * file descriptor. `fs.open(..., 'wx')` (O_CREAT|O_EXCL) fails with EEXIST on
 * any existing entry — including a symlink or hardlink planted after the
 * filename was chosen — so the descriptor we write is provably the file we
 * just created, never a followed symlink target. On EEXIST the next
 * `-<n>` suffix is tried, preserving the no-overwrite contract.
 */
async function writeFileExclusive(
  dir: string,
  filename: string,
  content: Buffer,
): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? filename : `${base}-${attempt}${ext}`;
    const fullPath = path.join(dir, candidate);
    // The filename is separator-free, but keep the canonical containment
    // check so a future refactor cannot silently weaken the boundary.
    const relative = path.relative(dir, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Resolved attachment path escaped the attachment directory');
    }
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(fullPath, 'wx');
      await handle.writeFile(content);
      return fullPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    } finally {
      await handle?.close();
    }
  }
}

/**
 * Read a response body stream with a hard byte cap, aborting the stream the
 * moment the cap is exceeded. The body is never fully materialized beyond
 * `maxBytes`, so a malicious or unexpectedly large Graph response cannot
 * exhaust connector memory. Handles both Node Readable (node-fetch) and web
 * ReadableStream (undici/native fetch) bodies.
 */
async function readStreamWithCap(
  body: unknown,
  maxBytes: number,
  onExceeded: () => Error,
): Promise<Buffer> {
  const readable =
    body instanceof Readable
      ? body
      : body && typeof (body as { getReader?: unknown }).getReader === 'function'
        ? Readable.fromWeb(body as WebReadableStream<Uint8Array>)
        : null;
  if (!readable) {
    throw new Error('Attachment download returned no readable content stream.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of readable) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.byteLength;
      if (total > maxBytes) throw onExceeded();
      chunks.push(buf);
    }
  } catch (err) {
    readable.destroy();
    throw err;
  }
  return Buffer.concat(chunks);
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
  // Fetch metadata first, explicitly excluding contentBytes so this response
  // is small and bounded; the bytes themselves are streamed (and capped)
  // below via the $value endpoint instead of an unbounded inline base64 JSON.
  const metaResponse = await client
    .api(`/me/messages/${args.id}/attachments/${args.attachmentId}`)
    .options({ signal })
    .select('id,name,contentType,size,isInline')
    .get();
  const attachment = GraphAttachmentSchema.parse(metaResponse);

  // The attachment name is attacker-controlled; every error path below must
  // carry it inside an untrusted-content envelope (invariant #6), never raw.
  const displayName =
    wrapUntrusted(attachment.name, 'microsoft-mail:download_attachment:name') ??
    args.attachmentId;
  const sizeLimitMessage = `Attachment "${displayName}" exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB download limit.`;

  if (attachment['@odata.type'] && !attachment['@odata.type'].endsWith('fileAttachment')) {
    throw new Error(
      `Attachment "${displayName}" is not a file attachment ` +
        `(${attachment['@odata.type'].replace('#microsoft.graph.', '')}); inline download is not ` +
        'supported for embedded-message or reference attachments. Open the message in Outlook to access it.',
    );
  }

  // Reject non-plain filenames before any content is fetched or written.
  const filename = sanitizeAttachmentFilename(attachment.name?.trim() || 'attachment');

  // Cheap early reject on the declared size so oversized attachments fail
  // without a content fetch; the streaming cap below is the hard guard for a
  // server that understates it.
  if (typeof attachment.size === 'number' && attachment.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(sizeLimitMessage);
  }

  const body = await client
    .api(`/me/messages/${args.id}/attachments/${args.attachmentId}/$value`)
    .options({ signal })
    .getStream();
  const content = await readStreamWithCap(body, MAX_ATTACHMENT_BYTES, () => new Error(sizeLimitMessage));

  const dir = await resolveAttachmentDir();
  const fullPath = await writeFileExclusive(dir, filename, content);

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
  // Microsoft Graph rejects $filter combined with $orderby (HTTP 400
  // InefficientFilter), like the $search limitation noted in searchEmails.
  // The conversation is sorted client-side below, oldest first.
  const endpoint =
    '/me/messages?' +
    [
      `$filter=conversationId eq '${conversationId}'`,
      `$top=${top}`,
      '$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments',
    ].join('&');

  const response = await client.api(endpoint).options({ signal }).get();
  const parsed = GraphConversationListSchema.parse(response);

  const formatted = [...parsed.value]
    .sort((a, b) => (a.receivedDateTime ?? '').localeCompare(b.receivedDateTime ?? ''))
    .map((email) => ({
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

export async function getAutomaticReplies(
  client: Client,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await client
    .api('/me/mailboxSettings/automaticRepliesSetting')
    .options({ signal })
    .get();
  const settings = AutomaticRepliesSettingSchema.parse(response);

  return {
    status: settings.status,
    externalAudience: settings.externalAudience,
    internalReplyMessage: wrapUntrusted(
      settings.internalReplyMessage,
      'microsoft-mail:get_automatic_replies:internalReplyMessage',
    ),
    externalReplyMessage: wrapUntrusted(
      settings.externalReplyMessage,
      'microsoft-mail:get_automatic_replies:externalReplyMessage',
    ),
    scheduledStart: settings.scheduledStartDateTime?.dateTime,
    scheduledEnd: settings.scheduledEndDateTime?.dateTime,
  };
}

export interface SetAutomaticRepliesArgs {
  status: 'disabled' | 'alwaysEnabled' | 'scheduled';
  internalReplyMessage?: string;
  externalReplyMessage?: string;
  externalAudience?: 'none' | 'contactsOnly' | 'all';
  scheduledStart?: string;
  scheduledEnd?: string;
}

// ISO 8601 date-time, with or without an explicit offset/"Z" suffix. A
// zone-less value is documented (and treated) as UTC below.
const ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

function normalizeScheduledDateTime(value: string, field: string): string {
  const trimmed = value.trim();
  const guidance =
    `Invalid ${field}: expected an ISO 8601 date-time such as "2026-08-10T09:00:00Z" ` +
    'or "2026-08-10T09:00:00+02:00".';
  if (!ISO_DATETIME_PATTERN.test(trimmed)) {
    throw new Error(guidance);
  }
  // Make the zone-less-is-UTC convention explicit before parsing so the
  // result does not depend on the host's local timezone.
  const hasExplicitZone = /(Z|[+-]\d{2}:\d{2})$/.test(trimmed);
  const parsed = new Date(hasExplicitZone ? trimmed : `${trimmed}Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(guidance);
  }
  // Graph's dateTimeTimeZone pairs a zone-less wall-clock string with the
  // timeZone field we send ("UTC"), so convert to UTC and strip the
  // milliseconds and trailing "Z" — passing an offset or "Z" through
  // verbatim would mislabel the instant.
  return parsed.toISOString().slice(0, 'YYYY-MM-DDTHH:mm:ss'.length);
}

/**
 * Validate and normalize a scheduled out-of-office window: both bounds must
 * be ISO 8601 date-times (offsets converted to UTC) and start must precede
 * end. Throws with actionable guidance otherwise. Idempotent — its own
 * output re-normalizes to itself.
 */
export function normalizeScheduledWindow(
  scheduledStart: string | undefined,
  scheduledEnd: string | undefined,
): { start: string; end: string } {
  const start = normalizeScheduledDateTime(scheduledStart ?? '', 'scheduledStart');
  const end = normalizeScheduledDateTime(scheduledEnd ?? '', 'scheduledEnd');
  if (start >= end) {
    throw new Error('Invalid schedule: scheduledStart must be earlier than scheduledEnd.');
  }
  return { start, end };
}

export async function setAutomaticReplies(
  client: Client,
  args: SetAutomaticRepliesArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const setting: Record<string, unknown> = { status: args.status };
  if (args.internalReplyMessage !== undefined) {
    setting.internalReplyMessage = args.internalReplyMessage;
  }
  if (args.externalReplyMessage !== undefined) {
    setting.externalReplyMessage = args.externalReplyMessage;
  }
  if (args.externalAudience !== undefined) {
    setting.externalAudience = args.externalAudience;
  }
  if (args.status === 'scheduled') {
    const { start, end } = normalizeScheduledWindow(args.scheduledStart, args.scheduledEnd);
    setting.scheduledStartDateTime = { dateTime: start, timeZone: 'UTC' };
    setting.scheduledEndDateTime = { dateTime: end, timeZone: 'UTC' };
  }

  const response = await client
    .api('/me/mailboxSettings')
    .options({ signal })
    .patch({ automaticRepliesSetting: setting });
  const updated = z
    .object({ automaticRepliesSetting: AutomaticRepliesSettingSchema })
    .passthrough()
    .parse(response);

  return {
    success: true,
    status: updated.automaticRepliesSetting.status ?? args.status,
    message:
      args.status === 'disabled'
        ? 'Automatic replies turned off'
        : 'Automatic replies updated',
  };
}
