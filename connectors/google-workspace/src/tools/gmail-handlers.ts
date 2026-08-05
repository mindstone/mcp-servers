import { getGmailService } from '../modules/gmail/index.js';
import { getAccountManager, validateEmail, resolveEmail } from '../modules/accounts/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { toMcpError } from '../utils/apiError.js';
import { SendEmailParams } from '../modules/gmail/types.js';
import {
  ManageLabelParams,
  ManageLabelAssignmentParams,
  ManageLabelFilterParams
} from '../modules/gmail/services/label.js';
import { AttachmentService } from '../modules/attachments/service.js';
import { ATTACHMENT_FOLDERS } from '../modules/attachments/types.js';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'fs';
import path from 'path';
import { McpToolResponse } from './types.js';
import { wrapUntrustedContent, wrapUntrustedJsonStrings } from '../utils/untrusted-content.js';

// Singleton instances
let gmailService: ReturnType<typeof getGmailService>;
let accountManager: ReturnType<typeof getAccountManager>;
let attachmentService: AttachmentService;

/**
 * Initialize required services
 */
async function initializeServices() {
  if (!gmailService) {
    gmailService = getGmailService();
    await gmailService.initialize();
  }
  
  if (!accountManager) {
    accountManager = getAccountManager();
  }

  if (!attachmentService) {
    attachmentService = AttachmentService.getInstance();
  }
}

import { 
  GmailAttachment, 
  OutgoingGmailAttachment,
  IncomingGmailAttachment
} from '../modules/gmail/types.js';
import { ManageAttachmentParams } from './types.js';

interface ReplyThreadingHeaders {
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
}

async function resolveReplyThreading(email: string, replyToMessageId: string): Promise<ReplyThreadingHeaders> {
  try {
    const originalMessage = await gmailService.getMessage(email, replyToMessageId);
    if (!originalMessage) {
      console.warn(`[gmail-handlers] Could not fetch message ${replyToMessageId} for threading — draft will be unthreaded`);
      return {};
    }

    const result: ReplyThreadingHeaders = { threadId: originalMessage.threadId };

    const messageIdHeader = originalMessage.headers?.find(
      (h: { name: string; value: string }) => h.name.toLowerCase() === 'message-id'
    );
    if (messageIdHeader) {
      result.inReplyTo = messageIdHeader.value;
    }

    const referencesHeader = originalMessage.headers?.find(
      (h: { name: string; value: string }) => h.name.toLowerCase() === 'references'
    );
    const existingRefs = referencesHeader?.value?.split(/\s+/).filter(Boolean) || [];
    if (result.inReplyTo) {
      const allRefs = [...existingRefs, result.inReplyTo];
      // Keep the first and last refs to preserve thread origin and immediate parent
      const MAX_REFS = 50;
      result.references = allRefs.length > MAX_REFS
        ? [allRefs[0], ...allRefs.slice(-(MAX_REFS - 1))]
        : allRefs;
    } else if (existingRefs.length > 0) {
      result.references = existingRefs;
    }

    return result;
  } catch (error) {
    console.warn(`[gmail-handlers] Failed to resolve threading for ${replyToMessageId}:`, error instanceof Error ? error.message : error);
    return {};
  }
}

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};

function isPathInsideDirectory(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

function getAttachmentWorkspaceRoot(): string {
  const workspaceBase = process.env.MCP_WORKSPACE_PATH || process.env.WORKSPACE_BASE_PATH;
  if (!workspaceBase) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Attachment paths require MCP_WORKSPACE_PATH to be set to the workspace root.'
    );
  }

  const rootPath = path.resolve(workspaceBase);
  const rootStats = lstatSync(rootPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'MCP_WORKSPACE_PATH must point to a real workspace directory, not a symlink or file.'
    );
  }

  return realpathSync.native(rootPath);
}

/** @internal Exported for tests. */
export function resolveAttachmentFromPath(filePath: string): { content: string; name: string; mimeType: string; size: number } {
  const rootRealpath = getAttachmentWorkspaceRoot();
  const candidatePath = path.resolve(filePath);
  const candidateStats = lstatSync(candidatePath);
  if (candidateStats.isSymbolicLink()) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Attachment path must not be a symbolic link.'
    );
  }

  const candidateRealpath = realpathSync.native(candidatePath);
  if (!isPathInsideDirectory(candidateRealpath, rootRealpath)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Attachment path must be within the workspace directory. Got: ${filePath}`
    );
  }

  // Open once and read through the fd: checking the path and then re-opening it
  // by name would leave a swap race between the containment check and the read.
  // O_NOFOLLOW (where the platform supports it) refuses a symlink planted in
  // that window.
  const fd = openSync(candidateRealpath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Attachment path must point to a regular file.'
      );
    }
    const content = readFileSync(fd);
    const ext = path.extname(candidateRealpath).toLowerCase();
    return {
      content: content.toString('base64'),
      name: path.basename(candidateRealpath),
      mimeType: MIME_TYPES[ext] || 'application/octet-stream',
      size: stats.size,
    };
  } finally {
    closeSync(fd);
  }
}

function processOutgoingAttachments(attachments?: OutgoingGmailAttachment[]): OutgoingGmailAttachment[] | undefined {
  return attachments?.map(attachment => {
    if (attachment.path && !attachment.content) {
      const resolved = resolveAttachmentFromPath(attachment.path);
      return {
        id: attachment.id || resolved.name,
        name: attachment.name || resolved.name,
        mimeType: attachment.mimeType || resolved.mimeType,
        size: attachment.size || resolved.size,
        content: resolved.content,
      } as OutgoingGmailAttachment;
    }
    if (!attachment.content) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Attachment requires either "content" (base64) or "path" (local file): ${attachment.name || 'unnamed'}`
      );
    }
    if (!attachment.name) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Attachment with "content" (base64) also requires "name" (filename).'
      );
    }
    const contentBytes = Buffer.from(attachment.content, 'base64');
    return {
      id: attachment.id || attachment.name,
      name: attachment.name,
      mimeType: attachment.mimeType || 'application/octet-stream',
      size: attachment.size || contentBytes.length,
      content: attachment.content,
    } as OutgoingGmailAttachment;
  });
}

function readAliasedString(args: Record<string, unknown>, canonicalKey: string, legacyKey: string): string | undefined {
  const value = args[canonicalKey] ?? args[legacyKey];
  return typeof value === 'string' ? value : undefined;
}

function readAliasedNumber(args: Record<string, unknown>, canonicalKey: string, legacyKey: string): number | undefined {
  const value = args[canonicalKey] ?? args[legacyKey];
  return typeof value === 'number' ? value : undefined;
}

function readAliasedBoolean(args: Record<string, unknown>, canonicalKey: string, legacyKey: string): boolean | undefined {
  const value = args[canonicalKey] ?? args[legacyKey];
  return typeof value === 'boolean' ? value : undefined;
}

function readAliasedStringArray(args: Record<string, unknown>, canonicalKey: string, legacyKey: string): string[] | undefined {
  const value = args[canonicalKey] ?? args[legacyKey];
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined;
}

interface SearchEmailsParams {
  email?: string;
  
  // Flat parameters (snake_case per MCP convention)
  query?: string;
  max_results?: number;
  from?: string | string[];
  to?: string | string[];
  subject?: string;
  after?: string;
  before?: string;
  hasAttachment?: boolean;
  isUnread?: boolean;
  labels?: string[];
  pageToken?: string;
  includeBody?: boolean;
  returnJson?: boolean;
  
  // Legacy nested parameters (backwards compatible)
  search?: {
    from?: string | string[];
    to?: string | string[];
    subject?: string;
    content?: string;
    after?: string;
    before?: string;
    hasAttachment?: boolean;
    labels?: string[];
    excludeLabels?: string[];
    includeSpam?: boolean;
    isUnread?: boolean;
  };
  options?: {
    maxResults?: number;
    pageToken?: string;
    format?: 'full' | 'metadata' | 'minimal';
    includeBody?: boolean;
    includeHeaders?: boolean;
    threadedView?: boolean;
    sortOrder?: 'asc' | 'desc';
  };
  messageIds?: string[];
}

/** @internal Exported for testing only. */
export function formatEmailsAsText(result: { emails: Array<{ id: string; threadId: string; from: string; to: string; subject: string; date: string; snippet?: string; body?: string; labelIds?: string[]; hasAttachment?: boolean; attachments?: Array<{ name: string }> }>, nextPageToken?: string, resultSummary: { total: number; returned: number; hasMore: boolean } }): string {
  const { emails, resultSummary } = result;
  
  if (emails.length === 0) {
    return 'No emails found matching your search criteria.';
  }

  const lines: string[] = [];
  lines.push(`Found ${resultSummary.returned} email${resultSummary.returned !== 1 ? 's' : ''}${resultSummary.hasMore ? ` (more available)` : ''}:\n`);

  emails.forEach((email, i) => {
    const isUnread = email.labelIds?.includes('UNREAD');
    const labels = email.labelIds?.filter(l => l !== 'UNREAD' && l !== 'INBOX').join(', ') || '';
    const attachmentNote = email.hasAttachment ? ' [has attachments]' : '';
    
    lines.push(`${i + 1}. **${email.subject || '(no subject)'}**${isUnread ? ' [UNREAD]' : ''}${attachmentNote}`);
    lines.push(`   From: ${email.from}`);
    lines.push(`   Date: ${email.date}`);
    if (email.snippet) {
      lines.push(`   Preview: "${email.snippet.substring(0, 150)}${email.snippet.length > 150 ? '...' : ''}"`);
    }
    if (email.attachments && email.attachments.length > 0) {
      const attachmentList = email.attachments.map(a => a.name).join(', ');
      lines.push(`   Attachments: ${attachmentList}`);
    }
    lines.push(`   [id: ${email.id}, thread: ${email.threadId}${labels ? `, labels: ${labels}` : ''}]`);
    lines.push('');
  });

  if (result.nextPageToken) {
    lines.push(`More results available. Use pageToken: "${result.nextPageToken}" to continue.`);
  }

  return wrapUntrustedContent(lines.join('\n'), 'google-workspace:gmail:search');
}

interface SendEmailRequestParams {
  email?: string;
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  isHtml?: boolean;
  attachments?: OutgoingGmailAttachment[];
  replyToMessageId?: string;
}

interface ComposeWorkspaceEmailParams {
  email?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

interface ComposeWorkspaceEmailResult {
  text: string;
  _meta: {
    ui: {
      resourceUri: string;
      presentation: 'primary';
      viewSummary: string;
      viewRoleLabel: string;
      structuredFallback: {
        kind: 'email-draft';
        payload: {
          to: string[];
          cc: string[];
          bcc: string[];
          subject: string;
          body: string;
        };
      };
    };
  };
  structuredContent: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    email: string;
  };
}

const ANSI_ESCAPE_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const HTML_TAG_PATTERN = /<[^>]*>/g;

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sanitizeViewSummaryPart(value: string): string {
  return value
    .replace(ANSI_ESCAPE_SEQUENCE_PATTERN, '')
    .replace(HTML_TAG_PATTERN, '')
    .trim();
}

interface ManageDraftParams {
  email?: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'send';
  draft_id?: string;
  draftId?: string;
  data?: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    is_html?: boolean;
    isHtml?: boolean;
    attachments?: OutgoingGmailAttachment[];
    reply_to_message_id?: string;
    replyToMessageId?: string;
    thread_id?: string;
    threadId?: string;
    in_reply_to?: string;
    inReplyTo?: string;
    references?: string[];
  };
}

function normalizeDraftData(data: ManageDraftParams['data']) {
  if (!data) {
    return undefined;
  }

  return {
    to: data.to,
    subject: data.subject,
    body: data.body,
    cc: data.cc,
    bcc: data.bcc,
    isHtml: data.is_html ?? data.isHtml,
    attachments: data.attachments,
    replyToMessageId: data.reply_to_message_id ?? data.replyToMessageId,
    threadId: data.thread_id ?? data.threadId,
    inReplyTo: data.in_reply_to ?? data.inReplyTo,
    references: data.references,
  };
}

// Fail loudly on a malformed recipient list — a non-array crashes buildMimeMessage
// deep in the service and used to surface as an opaque InternalError. Empty arrays are
// valid for drafts, so only the shape is checked here. Covers to/cc/bcc alike.
function assertRecipientsArray(value: unknown, field: 'to' | 'cc' | 'bcc'): void {
  if (value !== undefined && !Array.isArray(value)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Draft recipients (${field}) must be an array of email addresses`
    );
  }
}

export async function handleComposeWorkspaceEmail(
  params: ComposeWorkspaceEmailParams
): Promise<ComposeWorkspaceEmailResult> {
  const to = Array.isArray(params.to)
    ? params.to.filter((addr) => typeof addr === 'string' && addr.trim().length > 0)
    : [];
  const cc = Array.isArray(params.cc) ? params.cc : [];
  const bcc = Array.isArray(params.bcc) ? params.bcc : [];
  const subject = typeof params.subject === 'string' ? params.subject : '';
  const body = typeof params.body === 'string' ? params.body : '';

  if (to.length === 0 || subject.trim().length === 0 || body.trim().length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'compose_workspace_email requires non-empty "to" (at least one recipient), "subject", and "body". Provide all three so the editable draft has content for the user to review.'
    );
  }

  await initializeServices();
  const email = await resolveEmail(params);

  const recipientSummary = to.length > 0 ? to.join(', ') : '(no recipients)';
  const fallbackSubject = truncateText(subject, 256);
  const fallbackBody = truncateText(body, 5_000);
  const viewSummaryRecipient = truncateText(sanitizeViewSummaryPart(recipientSummary), 120);
  const viewSummarySubject = truncateText(sanitizeViewSummaryPart(subject), 120);
  const viewSummary = truncateText(
    `Email draft to ${viewSummaryRecipient || '(no recipients)'} — subject "${viewSummarySubject}".`,
    280,
  );

  const draftData = { to, cc, bcc, subject, body, email };

  return {
    text: `Drafting email to ${recipientSummary} with subject "${subject}"\n\n${JSON.stringify(draftData)}\n\n[View: ui://google-workspace/compose-email]`,
    _meta: {
      ui: {
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
        viewSummary,
        viewRoleLabel: 'Editable email draft',
        structuredFallback: {
          kind: 'email-draft',
          payload: { to, cc, bcc, subject: fallbackSubject, body: fallbackBody }
        }
      }
    },
    structuredContent: draftData
  };
}

export async function handleSearchWorkspaceEmails(params: SearchEmailsParams & Record<string, unknown>) {
  await initializeServices();
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);
  const rawParams = params as unknown as Record<string, unknown>;
  const hasAttachment = readAliasedBoolean(rawParams, 'has_attachment', 'hasAttachment');
  const isUnread = readAliasedBoolean(rawParams, 'is_unread', 'isUnread');
  const pageToken = readAliasedString(rawParams, 'page_token', 'pageToken');
  const includeBody = readAliasedBoolean(rawParams, 'include_body', 'includeBody');
  const messageIds = readAliasedStringArray(rawParams, 'message_ids', 'messageIds');

  // Merge flat parameters with legacy nested parameters (flat takes precedence)
  // This provides backwards compatibility while supporting the new flat schema
  const mergedSearch: SearchEmailsParams['search'] = {
    // Start with legacy nested search params
    ...params.search,
    // Flat params override nested (preferred API)
    ...(params.from !== undefined && { from: params.from }),
    ...(params.to !== undefined && { to: params.to }),
    ...(params.subject !== undefined && { subject: params.subject }),
    ...(params.after !== undefined && { after: params.after }),
    ...(params.before !== undefined && { before: params.before }),
    ...(hasAttachment !== undefined && { hasAttachment }),
    ...(isUnread !== undefined && { isUnread }),
    ...(params.labels !== undefined && { labels: params.labels }),
  };
  
  // Handle query param: maps to search.content, AND-ed with other filters
  // Also accept 'q' as alias for 'query' (common LLM pattern)
  const queryParam = params.query || (params as unknown as Record<string, unknown>).q as string | undefined;
  if (queryParam) {
    if (mergedSearch.content) {
      // AND the query with existing content
      mergedSearch.content = `(${mergedSearch.content}) (${queryParam})`;
    } else {
      mergedSearch.content = queryParam;
    }
  }
  
  // Merge options (snake_case canonical, flat params take precedence)
  const mergedOptions: SearchEmailsParams['options'] = {
    ...params.options,
    ...(params.max_results !== undefined && { maxResults: params.max_results }),
    ...(pageToken !== undefined && { pageToken }),
    ...(includeBody !== undefined && { includeBody }),
  };
  
  // Also accept backwards-compatible aliases: maxResults (camelCase), limit
  const unknownParams = params as unknown as Record<string, unknown>;
  if ('maxResults' in unknownParams && mergedOptions.maxResults === undefined) {
    mergedOptions.maxResults = unknownParams.maxResults as number;
  }
  if ('limit' in unknownParams && mergedOptions.maxResults === undefined) {
    mergedOptions.maxResults = unknownParams.limit as number;
  }
  
  const search = mergedSearch;
  const options = mergedOptions;

  // Normalize search.from - if it's a partial name (no @), convert to content query
  // This helps when LLMs pass names like "Solena" instead of full email addresses
  let normalizedSearch = { ...search };
  if (search.from && !search.content) {
    const fromValues = Array.isArray(search.from) ? search.from : [search.from];
    const hasPartialName = fromValues.some(f => !f.includes('@'));
    if (hasPartialName) {
      // Convert partial names to content query for better matching
      // Gmail's from: operator works with partial matches, but content search is more flexible
      const fromQuery = fromValues.map(f => `from:${f}`).join(' OR ');
      normalizedSearch = {
        ...search,
        from: undefined,
        content: search.content ? `(${search.content}) AND (${fromQuery})` : fromQuery
      };
    }
  }

  const returnJson = readAliasedBoolean(rawParams, 'return_json', 'returnJson') ?? false;

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await gmailService.getEmails({ email, search: normalizedSearch, options, messageIds });
      
      // Return formatted text by default, JSON only when explicitly requested
      if (returnJson) {
        return wrapUntrustedJsonStrings(result, 'google-workspace:gmail:search');
      }
      return formatEmailsAsText(result);
    } catch (error) {
      throw toMcpError(error, 'Failed to search emails');
    }
  });
}

interface GetThreadParams {
  email?: string;
  thread_id?: string;
  threadId?: string;
  max_messages?: number;
  maxMessages?: number;
  offset?: number;
  include_body?: boolean;
  includeBody?: boolean;
  include_full_bodies?: boolean;
  includeFullBodies?: boolean;
  return_json?: boolean;
  returnJson?: boolean;
}

// Format thread as human-readable text
const DEFAULT_FULL_BODY_TAIL = 2;

export function formatThreadAsText(result: { threadId: string; messagesCount: number; hasMore?: boolean; nextOffset?: number; messages: Array<{ id: string; from: string; to: string[]; date: string; subject: string; snippet?: string; body?: { text?: string; html?: string }; attachments?: Array<{ id: string; filename: string; mimeType: string; size: number }> }> }, offset = 0, includeFullBodies = false): string {
  const { threadId, messagesCount, hasMore, nextOffset, messages } = result;
  
  if (messages.length === 0) {
    if (offset > 0) {
      return wrapUntrustedContent(`Thread ${threadId} has no more messages beyond offset ${offset} (${messagesCount} total).`, `google-workspace:gmail:thread/${threadId}`);
    }
    return wrapUntrustedContent(`Thread ${threadId} is empty.`, `google-workspace:gmail:thread/${threadId}`);
  }

  // Get subject from first message
  const subject = messages[0]?.subject || '(no subject)';
  
  const lines: string[] = [];
  lines.push(`**Thread: ${subject}**`);
  lines.push(`[threadId: ${threadId}, ${messagesCount} message${messagesCount !== 1 ? 's' : ''}]\n`);

  const fullBodyThreshold = includeFullBodies ? -Infinity : messages.length - DEFAULT_FULL_BODY_TAIL;
  let abbreviatedCount = 0;

  messages.forEach((msg, i) => {
    lines.push(`--- Message ${offset + i + 1} of ${messagesCount} ---`);
    lines.push(`From: ${msg.from}`);
    lines.push(`To: ${msg.to.join(', ')}`);
    lines.push(`Date: ${msg.date}`);
    lines.push(`[id: ${msg.id}]`);

    const showFullBody = i >= fullBodyThreshold;
    if (showFullBody && msg.body?.text) {
      const bodyText = msg.body.text.length > 2000
        ? msg.body.text.substring(0, 2000) + '\n...[truncated]'
        : msg.body.text;
      lines.push(`\n${bodyText}`);
    } else if (msg.snippet) {
      lines.push(`\nPreview: "${msg.snippet}"`);
      if (!showFullBody) abbreviatedCount += 1;
    }
    if (msg.attachments && msg.attachments.length > 0) {
      const attachmentList = msg.attachments.map(a => {
        const sizeStr = a.size >= 1024 * 1024
          ? `${(a.size / (1024 * 1024)).toFixed(1)} MB`
          : a.size >= 1024
            ? `${(a.size / 1024).toFixed(0)} KB`
            : `${a.size} B`;
        return `${a.filename} (${sizeStr})`;
      }).join(', ');
      lines.push(`   📎 Attachments: ${attachmentList}`);
    }
    lines.push('');
  });

  if (abbreviatedCount > 0) {
    lines.push(`(${abbreviatedCount} earlier message${abbreviatedCount === 1 ? '' : 's'} abbreviated to preview only. Pass include_full_bodies: true to fetch full content.)`);
  }

  if (hasMore && nextOffset !== undefined) {
    lines.push(`More messages available. Use offset: ${nextOffset} to continue.`);
  }

  return wrapUntrustedContent(lines.join('\n'), `google-workspace:gmail:thread/${threadId}`);
}

export async function handleGetWorkspaceEmailThread(params: GetThreadParams) {
  await initializeServices();
  const rawParams = params as unknown as Record<string, unknown>;
  const threadId = readAliasedString(rawParams, 'thread_id', 'threadId');
  const maxMessages = readAliasedNumber(rawParams, 'max_messages', 'maxMessages') ?? 50;
  const offset = typeof params.offset === 'number' ? params.offset : 0;
  const includeBody = readAliasedBoolean(rawParams, 'include_body', 'includeBody') ?? true;
  const includeFullBodies = readAliasedBoolean(rawParams, 'include_full_bodies', 'includeFullBodies') ?? false;
  const returnJson = readAliasedBoolean(rawParams, 'return_json', 'returnJson') ?? false;
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  if (!threadId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "thread_id" (from search results or a message). ' +
      'Example: { "email": "user@example.com", "thread_id": "thread123" }'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await gmailService.getThread(email, threadId, { maxMessages, offset, includeBody });

      if (returnJson) {
        // JSON path: when full bodies aren't requested, strip body content from
        // every message except the last 2 so long threads stay token-cheap.
        // Snippet field is preserved so callers can still see what was elided.
        if (includeBody && !includeFullBodies && result.messages.length > DEFAULT_FULL_BODY_TAIL) {
          const tailStart = result.messages.length - DEFAULT_FULL_BODY_TAIL;
          return wrapUntrustedJsonStrings({
            ...result,
            bodies_abbreviated: tailStart,
            messages: result.messages.map((m, i) => i < tailStart ? { ...m, body: undefined } : m),
          }, `google-workspace:gmail:thread/${threadId}`);
        }
        return wrapUntrustedJsonStrings(result, `google-workspace:gmail:thread/${threadId}`);
      }
      return formatThreadAsText(result, offset, includeFullBodies);
    } catch (error) {
      throw toMcpError(error, 'Failed to get thread');
    }
  });
}

export async function handleSendWorkspaceEmail(params: SendEmailRequestParams & Record<string, unknown>) {
  await initializeServices();
  const { to, subject, body, cc, bcc, attachments } = params;
  const rawParams = params as unknown as Record<string, unknown>;
  const isHtml = readAliasedBoolean(rawParams, 'is_html', 'isHtml');
  const replyToMessageId = readAliasedString(rawParams, 'reply_to_message_id', 'replyToMessageId');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  // Catch common parameter mistakes
  const unknownParams = rawParams;

  // Catch 'recipient'/'recipients' instead of 'to'
  if ('recipient' in unknownParams || 'recipients' in unknownParams) {
    const passedRecipient = unknownParams.recipient || unknownParams.recipients;
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${unknownParams.recipient ? 'recipient' : 'recipients'}' is not supported. Use 'to' instead. ` +
      `Example: { "email": "sender@example.com", "to": ${JSON.stringify(Array.isArray(passedRecipient) ? passedRecipient : [passedRecipient])}, "subject": "...", "body": "..." }`
    );
  }

  // Catch 'message'/'content'/'text' instead of 'body'
  if ('message' in unknownParams || 'content' in unknownParams || 'text' in unknownParams) {
    const paramName = 'message' in unknownParams ? 'message' : ('content' in unknownParams ? 'content' : 'text');
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: '${paramName}' is not supported. Use 'body' instead. ` +
      `Example: { "email": "sender@example.com", "to": ["recipient@example.com"], "subject": "...", "body": "Your message here" }`
    );
  }

  // Catch 'html' instead of 'is_html'
  if ('html' in unknownParams) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: 'html' is not supported. Use 'is_html' (boolean) instead. ` +
      `Example: { "email": "...", "to": [...], "subject": "...", "body": "<html>...</html>", "is_html": true }`
    );
  }

  // Catch 'from' instead of 'email'
  if ('from' in unknownParams) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: 'from' is not supported. Use 'email' for the sender address. ` +
      `Example: { "email": "${unknownParams.from}", "to": [...], "subject": "...", "body": "..." }`
    );
  }

  if (!to || !Array.isArray(to) || to.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "to" (array of recipient email addresses). ' +
      'Example: { "email": "sender@example.com", "to": ["recipient@example.com"], "subject": "Hello", "body": "Message content" }'
    );
  }

  if (!subject) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "subject" (email subject line). ' +
      'Example: { "email": "sender@example.com", "to": ["recipient@example.com"], "subject": "Meeting Tomorrow", "body": "..." }'
    );
  }

  if (!body) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "body" (email content). ' +
      'Example: { "email": "...", "to": [...], "subject": "...", "body": "Your message here" }. ' +
      'For HTML emails, set "is_html": true'
    );
  }

  to.forEach(validateEmail);
  if (cc) cc.forEach(validateEmail);
  if (bcc) bcc.forEach(validateEmail);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const threading = replyToMessageId
        ? await resolveReplyThreading(email, replyToMessageId)
        : {};

      const emailParams: SendEmailParams = {
        email,
        to,
        subject,
        body,
        cc,
        bcc,
        isHtml,
        threadId: threading.threadId,
        inReplyTo: threading.inReplyTo,
        references: threading.references,
        attachments: processOutgoingAttachments(attachments)
      };

      const sendResult = await gmailService.sendEmail(emailParams);
      // Return an McpToolResponse-shaped result so the identifiers survive as
      // structuredContent (hoisted by super-mcp) — the compose-email UI reads
      // { messageId, threadId } from it to build an "Open in Gmail" deep link.
      // The text block preserves the same JSON the model saw before this change.
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(sendResult) }],
        structuredContent: sendResult,
      };
    } catch (error) {
      throw toMcpError(error, 'Failed to send email');
    }
  });
}

export async function handleGetWorkspaceGmailSettings(params: { email?: string }) {
  await initializeServices();
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      return await gmailService.getWorkspaceGmailSettings({ email });
    } catch (error) {
      throw toMcpError(error, 'Failed to get Gmail settings');
    }
  });
}

/**
 * Parses a vacation start/end timestamp per the repo's epoch-ms rules: a number
 * or digit-only string in the unambiguous epoch-ms window [1e12, 1e14), or a
 * parseable date string. Anything else — notably Unix *seconds* like
 * 1735689600, which would silently be 1000x off — is rejected.
 */
function parseEpochMsField(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 1e12 || value >= 1e14) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${fieldName} numbers must be epoch milliseconds (e.g. 1735689600000), not seconds`
      );
    }
    return value;
  }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      const parsed = Number(value);
      if (parsed >= 1e12 && parsed < 1e14) return parsed;
      throw new McpError(
        ErrorCode.InvalidParams,
        `${fieldName} digit-only strings must be epoch milliseconds (e.g. 1735689600000), not seconds`
      );
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${fieldName} must be epoch milliseconds or a parseable date string (e.g. "2026-08-07")`
      );
    }
    return parsed;
  }
  throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a number or a date string`);
}

export interface UpdateVacationResponderToolParams {
  email?: string;
  enabled?: boolean;
  response_subject?: string;
  responseSubject?: string;
  response_body?: string;
  responseBody?: string;
  start_time?: number | string;
  startTime?: number | string;
  end_time?: number | string;
  endTime?: number | string;
  clear_end_time?: boolean;
  clearEndTime?: boolean;
  contacts_only?: boolean;
  contactsOnly?: boolean;
  domain_only?: boolean;
  domainOnly?: boolean;
}

export async function handleUpdateWorkspaceVacationResponder(params: UpdateVacationResponderToolParams) {
  await initializeServices();
  const rawParams = params as unknown as Record<string, unknown>;
  const email = await resolveEmail(params);

  const enabled = readAliasedBoolean(rawParams, 'enabled', 'enabled');
  if (enabled === undefined) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "enabled" (true to turn the out-of-office reply on, false to turn it off)'
    );
  }

  const startTime = parseEpochMsField(rawParams.start_time ?? rawParams.startTime, 'start_time');
  const endTime = parseEpochMsField(rawParams.end_time ?? rawParams.endTime, 'end_time');
  const clearEndTime = readAliasedBoolean(rawParams, 'clear_end_time', 'clearEndTime') ?? false;
  if (clearEndTime && endTime !== undefined) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Pass either end_time or clear_end_time, not both'
    );
  }
  if (startTime !== undefined && endTime !== undefined && endTime <= startTime) {
    throw new McpError(ErrorCode.InvalidParams, 'end_time must be after start_time');
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await gmailService.updateVacationResponder({
        email,
        enabled,
        responseSubject: readAliasedString(rawParams, 'response_subject', 'responseSubject'),
        responseBody: readAliasedString(rawParams, 'response_body', 'responseBody'),
        startTime,
        endTime,
        clearEndTime,
        contactsOnly: readAliasedBoolean(rawParams, 'contacts_only', 'contactsOnly'),
        domainOnly: readAliasedBoolean(rawParams, 'domain_only', 'domainOnly')
      });
      return wrapUntrustedJsonStrings(result, 'google-workspace:gmail:vacation-responder');
    } catch (error) {
      throw toMcpError(error, 'Failed to update vacation responder');
    }
  });
}

export async function handleListWorkspaceSendAs(params: { email?: string }) {
  await initializeServices();
  const email = await resolveEmail(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await gmailService.listSendAs({ email });
      return wrapUntrustedJsonStrings(result, 'google-workspace:gmail:send-as');
    } catch (error) {
      throw toMcpError(error, 'Failed to list send-as aliases');
    }
  });
}

export async function handleManageWorkspaceDraft(params: ManageDraftParams) {
  await initializeServices();
  const rawParams = params as unknown as Record<string, unknown>;
  const action = params.action;
  const draftId = readAliasedString(rawParams, 'draft_id', 'draftId');
  const data = normalizeDraftData(params.data);
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  if (!action) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Action is required'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      // Resolve reply threading headers if replyToMessageId is provided
      const threading = data?.replyToMessageId
        ? await resolveReplyThreading(email, data.replyToMessageId)
        : {};

      switch (action) {
        case 'create':
          if (!data) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Draft data is required for create action'
            );
          }
          assertRecipientsArray(data.to, 'to');
          assertRecipientsArray(data.cc, 'cc');
          assertRecipientsArray(data.bcc, 'bcc');
          if (data.to) data.to.forEach(validateEmail);
          if (data.cc) data.cc.forEach(validateEmail);
          if (data.bcc) data.bcc.forEach(validateEmail);
          {
            // Destructure replyToMessageId out so it doesn't leak to the service
            const { replyToMessageId: _, ...draftData } = data;
            return await gmailService.manageDraft({
              email,
              action: 'create',
              data: {
                ...draftData,
                threadId: data.threadId ?? threading.threadId,
                inReplyTo: data.inReplyTo ?? threading.inReplyTo,
                references: data.references ?? threading.references,
                attachments: processOutgoingAttachments(data.attachments)
              }
            });
          }

        case 'read':
          return await gmailService.manageDraft({
            email,
            action: 'read',
            draftId
          });

        case 'update':
          if (!draftId || !data) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Draft ID and data are required for update action'
            );
          }
          assertRecipientsArray(data.to, 'to');
          assertRecipientsArray(data.cc, 'cc');
          assertRecipientsArray(data.bcc, 'bcc');
          if (data.to) data.to.forEach(validateEmail);
          if (data.cc) data.cc.forEach(validateEmail);
          if (data.bcc) data.bcc.forEach(validateEmail);
          {
            const { replyToMessageId: _, ...draftData } = data;
            return await gmailService.manageDraft({
              email,
              action: 'update',
              draftId,
              data: {
                ...draftData,
                threadId: data.threadId ?? threading.threadId,
                inReplyTo: data.inReplyTo ?? threading.inReplyTo,
                references: data.references ?? threading.references,
                attachments: processOutgoingAttachments(data.attachments)
              }
            });
          }

        case 'delete':
          if (!draftId) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Draft ID is required for delete action'
            );
          }
          return await gmailService.manageDraft({
            email,
            action: 'delete',
            draftId
          });

        case 'send':
          if (!draftId) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Draft ID is required for send action'
            );
          }
          return await gmailService.manageDraft({
            email,
            action: 'send',
            draftId
          });

        default:
          throw new McpError(
            ErrorCode.InvalidParams,
            'Invalid action. Supported actions are: create, read, update, delete, send'
          );
      }
    } catch (error) {
      throw toMcpError(error, 'Failed to manage draft');
    }
  });
}

export async function handleManageWorkspaceLabel(params: ManageLabelParams) {
  await initializeServices();
  const rawParams = params as unknown as Record<string, unknown>;
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);
  const labelId = readAliasedString(rawParams, 'label_id', 'labelId');
  const rawData = (rawParams.data ?? {}) as Record<string, unknown>;
  const messageListVisibility = readAliasedString(rawParams, 'message_list_visibility', 'messageListVisibility')
    ?? (typeof rawData.messageListVisibility === 'string' ? rawData.messageListVisibility : undefined);
  const labelListVisibility = readAliasedString(rawParams, 'label_list_visibility', 'labelListVisibility')
    ?? (typeof rawData.labelListVisibility === 'string' ? rawData.labelListVisibility : undefined);
  const data = {
    ...(typeof rawData.name === 'string' ? { name: rawData.name } : {}),
    ...(messageListVisibility ? { messageListVisibility: messageListVisibility as NonNullable<ManageLabelParams['data']>['messageListVisibility'] } : {}),
    ...(labelListVisibility ? { labelListVisibility: labelListVisibility as NonNullable<ManageLabelParams['data']>['labelListVisibility'] } : {}),
    ...(typeof rawData.color === 'object' && rawData.color !== null ? { color: rawData.color as NonNullable<ManageLabelParams['data']>['color'] } : {}),
  };

  return accountManager.withTokenRenewal(email, async () => {
    try {
      return await gmailService.manageLabel({
        action: params.action,
        email,
        ...(labelId ? { labelId } : {}),
        ...(Object.keys(data).length > 0 ? { data } : {}),
      });
    } catch (error) {
      throw toMcpError(error, 'Failed to manage label');
    }
  });
}

export async function handleManageWorkspaceLabelAssignment(params: ManageLabelAssignmentParams) {
  await initializeServices();
  const rawParams = params as unknown as Record<string, unknown>;
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);
  const messageId = readAliasedString(rawParams, 'message_id', 'messageId');
  const labelIds = readAliasedStringArray(rawParams, 'label_ids', 'labelIds');

  return accountManager.withTokenRenewal(email, async () => {
    try {
      await gmailService.manageLabelAssignment({
        action: params.action,
        email,
        messageId: messageId as string,
        labelIds: labelIds as string[],
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true })
        }]
      };
    } catch (error) {
      throw toMcpError(error, 'Failed to manage label assignment');
    }
  });
}

export async function handleManageWorkspaceAttachment(params: ManageAttachmentParams) {
  await initializeServices();
  const rawParams = params as unknown as Record<string, unknown>;
  const { action, source, filename, content } = params;
  const messageId = readAliasedString(rawParams, 'message_id', 'messageId');
  const mimeType = readAliasedString(rawParams, 'mime_type', 'mimeType');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  // Validate all required parameters
  if (!action || !source || !messageId || !filename) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'Invalid attachment management parameters. Required: action, source, message_id, filename'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      // Get shared attachment service instance
      if (!attachmentService) {
        attachmentService = AttachmentService.getInstance();
        await attachmentService.initialize(email);
      }

      // Determine parent folder based on source
      const parentFolder = source === 'email' ? 
        ATTACHMENT_FOLDERS.EMAIL : 
        ATTACHMENT_FOLDERS.CALENDAR;

      switch (action) {
        case 'download': {
          // Check local storage first (handles files uploaded via upload_workspace_attachment)
          const localResult = await attachmentService.findAttachmentByFilename(
            email,
            filename,
            parentFolder
          );

          if (localResult.success) {
            return {
              success: true,
              attachment: localResult.attachment
            };
          }

          // Fall back to Gmail API for real Gmail attachments
          const gmailAttachment = await gmailService.getAttachment(email, messageId, filename);
          
          if (!gmailAttachment || !gmailAttachment.content) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Attachment not found or content missing'
            );
          }

          // Process and save the attachment locally
          const result = await attachmentService.processAttachment(
            email,
            {
              content: gmailAttachment.content,
              metadata: {
                name: gmailAttachment.name || `attachment_${Date.now()}`,
                mimeType: gmailAttachment.mimeType || 'application/octet-stream',
                size: gmailAttachment.size || 0
              }
            },
            parentFolder
          );

          if (!result.success) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to save attachment: ${result.error}`
            );
          }

          return {
            success: true,
            attachment: result.attachment
          };
        }

        case 'upload': {
          if (!content) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'File content is required for upload'
            );
          }

          // Process attachment using provided filename and mimeType
          const result = await attachmentService.processAttachment(
            email,
            {
              content,
              metadata: {
                name: filename,
                mimeType: mimeType || 'application/octet-stream',
              }
            },
            parentFolder
          );

          if (!result.success) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to upload attachment: ${result.error}`
            );
          }

          return {
            success: true,
            attachment: result.attachment
          };
        }

        case 'delete': {
          // Delete attachment by scanning local storage for matching filename
          // The attachment must have been previously downloaded to local storage
          const result = await attachmentService.deleteAttachmentByFilename(
            email,
            filename,
            parentFolder
          );

          if (!result.success) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              result.error || 'Failed to delete attachment'
            );
          }

          return {
            success: true,
            attachment: result.attachment
          };
        }

        default:
          throw new McpError(
            ErrorCode.InvalidParams,
            'Invalid action. Supported actions are: download, upload, delete'
          );
      }
    } catch (error) {
      throw toMcpError(error, 'Failed to manage attachment');
    }
  });
}

export async function handleManageWorkspaceLabelFilter(params: ManageLabelFilterParams) {
  await initializeServices();
  const rawParams = params as unknown as Record<string, unknown>;
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);
  const filterId = readAliasedString(rawParams, 'filter_id', 'filterId');
  const labelId = readAliasedString(rawParams, 'label_id', 'labelId');
  const data = typeof rawParams.data === 'object' && rawParams.data !== null
    ? rawParams.data as ManageLabelFilterParams['data']
    : undefined;

  return accountManager.withTokenRenewal(email, async () => {
    try {
      return await gmailService.manageLabelFilter({
        action: params.action,
        email,
        ...(filterId ? { filterId } : {}),
        ...(labelId ? { labelId } : {}),
        ...(data ? { data } : {}),
      });
    } catch (error) {
      throw toMcpError(error, 'Failed to manage label filter');
    }
  });
}

// --- Individual Draft Operation Handlers ---
// These delegate to handleManageWorkspaceDraft with the appropriate action.

export async function handleListWorkspaceDrafts(params: { email?: string }) {
  return handleManageWorkspaceDraft({ ...params, action: 'read' });
}

export async function handleGetWorkspaceDraft(params: { email?: string; draftId: string }) {
  return handleManageWorkspaceDraft({ ...params, action: 'read' });
}

export async function handleCreateWorkspaceDraft(params: Record<string, unknown>) {
  const { email, ...data } = params;
  return handleManageWorkspaceDraft({ email: email as string | undefined, action: 'create', data: data as ManageDraftParams['data'] });
}

export async function handleUpdateWorkspaceDraft(params: Record<string, unknown>) {
  const email = params.email as string | undefined;
  const draftId = readAliasedString(params, 'draft_id', 'draftId');
  const { draft_id: _draftIdSnake, draftId: _draftIdCamel, ...data } = params;
  return handleManageWorkspaceDraft({ email, action: 'update', draftId, data: data as ManageDraftParams['data'] });
}

export async function handleDeleteWorkspaceDraft(params: { email?: string; draft_id?: string; draftId?: string }) {
  const draftId = readAliasedString(params as unknown as Record<string, unknown>, 'draft_id', 'draftId');
  return handleManageWorkspaceDraft({ ...params, draftId, action: 'delete' });
}

export async function handleSendWorkspaceDraft(params: { email?: string; draft_id?: string; draftId?: string }) {
  const draftId = readAliasedString(params as unknown as Record<string, unknown>, 'draft_id', 'draftId');
  return handleManageWorkspaceDraft({ ...params, draftId, action: 'send' });
}

// --- Individual Attachment Operation Handlers ---
// These delegate to handleManageWorkspaceAttachment with the appropriate action.

export async function handleDownloadWorkspaceAttachment(params: { email?: string; source: 'email' | 'calendar'; message_id?: string; messageId?: string; filename: string }) {
  const messageId = readAliasedString(params as unknown as Record<string, unknown>, 'message_id', 'messageId');
  return handleManageWorkspaceAttachment({ ...params, messageId: messageId as string, action: 'download' });
}

export async function handleUploadWorkspaceAttachment(params: { email?: string; source: 'email' | 'calendar'; message_id?: string; messageId?: string; filename: string; mime_type?: string; mimeType?: string; content: string }) {
  const rawParams = params as unknown as Record<string, unknown>;
  const messageId = readAliasedString(rawParams, 'message_id', 'messageId');
  const mimeType = readAliasedString(rawParams, 'mime_type', 'mimeType');
  return handleManageWorkspaceAttachment({ ...params, messageId: messageId as string, mimeType, action: 'upload' });
}

export async function handleDeleteWorkspaceAttachment(params: { email?: string; source: 'email' | 'calendar'; message_id?: string; messageId?: string; filename: string }) {
  const messageId = readAliasedString(params as unknown as Record<string, unknown>, 'message_id', 'messageId');
  return handleManageWorkspaceAttachment({ ...params, messageId: messageId as string, action: 'delete' });
}

// --- Individual Label Operation Handlers ---
// These delegate to handleManageWorkspaceLabel with the appropriate action.

export async function handleListWorkspaceLabels(params: { email?: string }) {
  return handleManageWorkspaceLabel({ action: 'read', email: params.email || '' } as ManageLabelParams);
}

export async function handleGetWorkspaceLabel(params: { email?: string; label_id?: string; labelId?: string }) {
  const labelId = readAliasedString(params as unknown as Record<string, unknown>, 'label_id', 'labelId');
  return handleManageWorkspaceLabel({ action: 'read', email: params.email || '', labelId } as ManageLabelParams);
}

export async function handleCreateWorkspaceLabel(params: Record<string, unknown>) {
  const { email, message_list_visibility, messageListVisibility, label_list_visibility, labelListVisibility, ...rest } = params;
  return handleManageWorkspaceLabel({
    action: 'create',
    email: (email as string) || '',
    ...rest,
    ...(message_list_visibility !== undefined || messageListVisibility !== undefined
      ? { messageListVisibility: (message_list_visibility ?? messageListVisibility) as string }
      : {}),
    ...(label_list_visibility !== undefined || labelListVisibility !== undefined
      ? { labelListVisibility: (label_list_visibility ?? labelListVisibility) as string }
      : {}),
  } as unknown as ManageLabelParams);
}

export async function handleUpdateWorkspaceLabel(params: Record<string, unknown>) {
  const labelId = readAliasedString(params, 'label_id', 'labelId');
  const { email, label_id: _labelIdSnake, labelId: _labelIdCamel, message_list_visibility, messageListVisibility, label_list_visibility, labelListVisibility, ...rest } = params;
  return handleManageWorkspaceLabel({
    action: 'update',
    email: (email as string) || '',
    labelId,
    ...rest,
    ...(message_list_visibility !== undefined || messageListVisibility !== undefined
      ? { messageListVisibility: (message_list_visibility ?? messageListVisibility) as string }
      : {}),
    ...(label_list_visibility !== undefined || labelListVisibility !== undefined
      ? { labelListVisibility: (label_list_visibility ?? labelListVisibility) as string }
      : {}),
  } as unknown as ManageLabelParams);
}

export async function handleDeleteWorkspaceLabel(params: { email?: string; label_id?: string; labelId?: string }) {
  const labelId = readAliasedString(params as unknown as Record<string, unknown>, 'label_id', 'labelId');
  return handleManageWorkspaceLabel({ action: 'delete', email: params.email || '', labelId } as ManageLabelParams);
}

// --- Individual Label Filter Operation Handlers ---
// These delegate to handleManageWorkspaceLabelFilter with the appropriate action.

export async function handleListWorkspaceLabelFilters(params: { email?: string; label_id?: string; labelId?: string }) {
  const labelId = readAliasedString(params as unknown as Record<string, unknown>, 'label_id', 'labelId');
  return handleManageWorkspaceLabelFilter({ action: 'read', email: params.email || '', ...(labelId ? { labelId } : {}) } as ManageLabelFilterParams);
}

export async function handleCreateWorkspaceLabelFilter(params: Record<string, unknown>) {
  const labelId = readAliasedString(params, 'label_id', 'labelId');
  const { email, data } = params;
  return handleManageWorkspaceLabelFilter({ action: 'create', email: (email as string) || '', labelId, data } as ManageLabelFilterParams);
}

export async function handleUpdateWorkspaceLabelFilter(params: Record<string, unknown>) {
  const filterId = readAliasedString(params, 'filter_id', 'filterId');
  const labelId = readAliasedString(params, 'label_id', 'labelId');
  const { email, data } = params;
  return handleManageWorkspaceLabelFilter({ action: 'update', email: (email as string) || '', filterId, labelId, data } as ManageLabelFilterParams);
}

export async function handleDeleteWorkspaceLabelFilter(params: { email?: string; filter_id?: string; filterId?: string }) {
  const filterId = readAliasedString(params as unknown as Record<string, unknown>, 'filter_id', 'filterId');
  return handleManageWorkspaceLabelFilter({ action: 'delete', email: params.email || '', filterId } as ManageLabelFilterParams);
}

// --- Gmail Quick Action Handlers ---

interface GmailQuickActionParams {
  email?: string;
  message_id?: string;
  messageId?: string;
  message_ids?: string[];
  messageIds?: string[];
}

/**
 * Resolves messageId / messageIds into a single array.
 * At least one must be present.
 */
function resolveMessageIds(params: GmailQuickActionParams): string[] {
  const ids: string[] = [];
  if (params.message_id ?? params.messageId) ids.push((params.message_id ?? params.messageId) as string);
  if (params.message_ids ?? params.messageIds) ids.push(...((params.message_ids ?? params.messageIds) as string[]));
  if (ids.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: provide "message_id" (string) or "message_ids" (string array). ' +
      'Example: { "message_id": "18c5a2b3d4e5f6g7" } or { "message_ids": ["id1", "id2"] }'
    );
  }
  return ids;
}

export async function handleArchiveWorkspaceEmail(params: GmailQuickActionParams): Promise<McpToolResponse | string | object> {
  await initializeServices();
  const email = await resolveEmail(params);
  const ids = resolveMessageIds(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      for (const messageId of ids) {
        await gmailService.manageLabelAssignment({
          email,
          messageId,
          action: 'remove',
          labelIds: ['INBOX'],
        });
      }
      return ids.length === 1
        ? `Message ${ids[0]} archived successfully.`
        : `${ids.length} messages archived successfully.`;
    } catch (error) {
      throw toMcpError(error, 'Failed to archive email');
    }
  });
}

export async function handleTrashWorkspaceEmail(params: GmailQuickActionParams): Promise<McpToolResponse | string | object> {
  await initializeServices();
  const email = await resolveEmail(params);
  const ids = resolveMessageIds(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      for (const messageId of ids) {
        await gmailService.trashMessage(email, messageId);
      }
      return ids.length === 1
        ? `Message ${ids[0]} moved to trash.`
        : `${ids.length} messages moved to trash.`;
    } catch (error) {
      throw toMcpError(error, 'Failed to trash email');
    }
  });
}

export async function handleUntrashWorkspaceEmail(params: GmailQuickActionParams): Promise<McpToolResponse | string | object> {
  await initializeServices();
  const email = await resolveEmail(params);
  const ids = resolveMessageIds(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      for (const messageId of ids) {
        await gmailService.untrashMessage(email, messageId);
      }
      return ids.length === 1
        ? `Message ${ids[0]} restored from trash.`
        : `${ids.length} messages restored from trash.`;
    } catch (error) {
      throw toMcpError(error, 'Failed to untrash email');
    }
  });
}

export async function handleMarkWorkspaceEmailRead(params: GmailQuickActionParams): Promise<McpToolResponse | string | object> {
  await initializeServices();
  const email = await resolveEmail(params);
  const ids = resolveMessageIds(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      for (const messageId of ids) {
        await gmailService.manageLabelAssignment({
          email,
          messageId,
          action: 'remove',
          labelIds: ['UNREAD'],
        });
      }
      return ids.length === 1
        ? `Message ${ids[0]} marked as read.`
        : `${ids.length} messages marked as read.`;
    } catch (error) {
      throw toMcpError(error, 'Failed to mark email as read');
    }
  });
}

export async function handleMarkWorkspaceEmailUnread(params: GmailQuickActionParams): Promise<McpToolResponse | string | object> {
  await initializeServices();
  const email = await resolveEmail(params);
  const ids = resolveMessageIds(params);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      for (const messageId of ids) {
        await gmailService.manageLabelAssignment({
          email,
          messageId,
          action: 'add',
          labelIds: ['UNREAD'],
        });
      }
      return ids.length === 1
        ? `Message ${ids[0]} marked as unread.`
        : `${ids.length} messages marked as unread.`;
    } catch (error) {
      throw toMcpError(error, 'Failed to mark email as unread');
    }
  });
}
