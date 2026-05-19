import type { Client, EmailMessage, MailFolder } from '@mindstone/mcp-server-microsoft-shared';

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

export async function listEmails(client: Client, args: ListEmailsArgs): Promise<unknown> {
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

  const response = await client.api(endpoint).get();
  const emails: EmailMessage[] = response.value ?? [];

  const formatted = emails.map((email) => ({
    id: email.id,
    subject: email.subject,
    from: email.from?.emailAddress?.address,
    fromName: email.from?.emailAddress?.name,
    receivedAt: email.receivedDateTime,
    preview: email.bodyPreview?.substring(0, 200),
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

export async function getEmail(client: Client, args: GetEmailArgs): Promise<unknown> {
  const email = await client
    .api(`/me/messages/${args.id}`)
    .select('id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,hasAttachments,importance')
    .get();

  return {
    id: email.id,
    subject: email.subject,
    from: email.from?.emailAddress,
    to: email.toRecipients?.map((r: { emailAddress?: unknown }) => r.emailAddress),
    cc: email.ccRecipients?.map((r: { emailAddress?: unknown }) => r.emailAddress),
    receivedAt: email.receivedDateTime,
    body: email.body?.content,
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
  importance?: 'low' | 'normal' | 'high';
}

export async function sendEmail(
  client: Client,
  args: SendEmailArgs,
): Promise<unknown> {
  const toList = ensureArray(args.to) ?? [];
  const ccList = ensureArray(args.cc);

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
    importance: args.importance ?? 'normal',
  };

  await client.api('/me/sendMail').post({ message });

  return {
    success: true,
    message: `Email sent to ${toList.join(', ')}`,
  };
}

export interface SearchEmailsArgs {
  query: string;
  top?: number;
}

export async function searchEmails(client: Client, args: SearchEmailsArgs): Promise<unknown> {
  const top = Math.min(args.top ?? 25, 100);

  // Note: Microsoft Graph API does not support $orderBy with $search.
  // Search results are automatically sorted by date (newest first).
  const response = await client
    .api('/me/messages')
    .search(`"${args.query}"`)
    .top(top)
    .select('id,subject,from,receivedDateTime,bodyPreview,isRead')
    .get();

  const emails: EmailMessage[] = response.value ?? [];

  const formatted = emails.map((email) => ({
    id: email.id,
    subject: email.subject,
    from: email.from?.emailAddress?.address,
    receivedAt: email.receivedDateTime,
    preview: email.bodyPreview?.substring(0, 200),
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

export async function replyToEmail(client: Client, args: ReplyToEmailArgs): Promise<unknown> {
  const endpoint = args.replyAll
    ? `/me/messages/${args.id}/replyAll`
    : `/me/messages/${args.id}/reply`;

  await client.api(endpoint).post({
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

export async function forwardEmail(client: Client, args: ForwardEmailArgs): Promise<unknown> {
  const toList = ensureArray(args.to) ?? [];

  await client.api(`/me/messages/${args.id}/forward`).post({
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

export async function deleteEmail(client: Client, args: DeleteEmailArgs): Promise<unknown> {
  if (args.permanent) {
    await client.api(`/me/messages/${args.id}`).delete();
    return { success: true, message: 'Email permanently deleted' };
  }

  await client.api(`/me/messages/${args.id}/move`).post({
    destinationId: 'deleteditems',
  });

  return { success: true, message: 'Email moved to Deleted Items' };
}

export interface ListFoldersArgs {
  includeHidden?: boolean;
}

export async function listFolders(client: Client, args: ListFoldersArgs): Promise<unknown> {
  let endpoint = '/me/mailFolders';
  if (!args.includeHidden) {
    endpoint += '?$filter=isHidden eq false';
  }

  const response = await client.api(endpoint).get();
  const folders: MailFolder[] = response.value ?? [];

  const formatted = folders.map((folder) => ({
    id: folder.id,
    name: folder.displayName,
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

export async function moveEmail(client: Client, args: MoveEmailArgs): Promise<unknown> {
  const folderId = resolveFolder(args.destinationFolder);

  await client.api(`/me/messages/${args.id}/move`).post({
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

  const response = await client.api(endpoint).post(requestBody);

  return {
    success: true,
    draftId: response.id,
    conversationId: response.conversationId,
    subject: response.subject,
    message: `Reply draft created${args.replyAll ? ' (reply-all)' : ''}. Open Outlook to review and send.`,
  };
}

export interface CreateDraftArgs {
  to?: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
}

export async function createDraft(client: Client, args: CreateDraftArgs): Promise<unknown> {
  const toList = ensureArray(args.to);
  const ccList = ensureArray(args.cc);

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
  };

  const response = await client.api('/me/messages').post(draft);

  return {
    success: true,
    draftId: response.id,
    message: 'Draft created successfully',
  };
}
