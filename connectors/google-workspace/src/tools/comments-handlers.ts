import { getAccountManager } from '../modules/accounts/index.js';
import { getCommentsService } from '../modules/comments/index.js';
import { resolveEmail } from '../modules/accounts/index.js';
import { CommentInfo, ReplyInfo } from '../modules/comments/types.js';
import { McpToolResponse } from './types.js';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';
import {
  readAliasedBoolean,
  readAliasedNumber,
  readAliasedString,
  readAliasedValue
} from './arg-aliases.js';

interface ListCommentsArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
  page_size?: number;
  pageSize?: number;
  page_token?: string;
  pageToken?: string;
  include_deleted?: boolean;
  includeDeleted?: boolean;
}

interface CreateCommentArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
  content: string;
  anchor?: string;
  quoted_file_content?: { mimeType: string; value: string };
  quotedFileContent?: { mimeType: string; value: string };
}

interface ResolveCommentArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
  comment_id?: string;
  commentId?: string;
  action: 'resolve' | 'reopen';
}

interface ReplyToCommentArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
  comment_id?: string;
  commentId?: string;
  content: string;
}

interface DeleteCommentArgs {
  email?: string;
  file_id?: string;
  fileId?: string;
  comment_id?: string;
  commentId?: string;
}

export function formatCommentAsText(comment: CommentInfo): string {
  const lines: string[] = [];
  const status = comment.resolved ? '[RESOLVED]' : '[OPEN]';
  lines.push(`${status} Comment ID: ${comment.commentId}`);
  lines.push(`  Author: ${comment.author.displayName}${comment.author.emailAddress ? ` (${comment.author.emailAddress})` : ''}`);
  lines.push(`  Content: ${comment.content}`);
  lines.push(`  Created: ${comment.createdTime}`);
  if (comment.quotedFileContent?.value) {
    lines.push(`  Quoted text: "${comment.quotedFileContent.value}"`);
  }
  if (comment.replies && comment.replies.length > 0) {
    lines.push(`  Replies (${comment.replies.length}):`);
    for (const reply of comment.replies) {
      const action = reply.action ? ` [${reply.action}]` : '';
      lines.push(`    - ${reply.author.displayName}: ${reply.content}${action}`);
    }
  }
  return wrapUntrustedContent(lines.join('\n'), `google-workspace:comments:comment/${comment.commentId}`);
}

export async function handleListComments(args: ListCommentsArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  const rawArgs = args as unknown as Record<string, unknown>;
  const fileId = readAliasedString(rawArgs, 'file_id', 'fileId');
  const pageSize = readAliasedNumber(rawArgs, 'page_size', 'pageSize');
  const pageToken = readAliasedString(rawArgs, 'page_token', 'pageToken');
  const includeDeleted = readAliasedBoolean(rawArgs, 'include_deleted', 'includeDeleted');

  return await accountManager.withTokenRenewal(email, async () => {
    const service = getCommentsService();

    const result = await service.listComments(email, {
      fileId: fileId as string,
      pageSize,
      pageToken,
      includeDeleted,
    });

    if (!result.success) {
      throw new Error(`Failed to list comments: ${result.error}`);
    }

    const comments = result.data as CommentInfo[];
    if (!comments || comments.length === 0) {
      return 'No comments found on this file.';
    }

    const lines: string[] = [`Comments on file (${comments.length}):\n`];
    for (const comment of comments) {
      lines.push(formatCommentAsText(comment));
      lines.push('');
    }

    if (result.nextPageToken) {
      lines.push(`\nMore comments available. Use page_token: "${result.nextPageToken}" to fetch the next page.`);
    }

    return lines.join('\n');
  });
}

export async function handleCreateComment(args: CreateCommentArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  const rawArgs = args as unknown as Record<string, unknown>;
  const fileId = readAliasedString(rawArgs, 'file_id', 'fileId');
  const quotedFileContent = readAliasedValue<{ mimeType: string; value: string }>(
    rawArgs,
    'quoted_file_content',
    'quotedFileContent'
  );

  return await accountManager.withTokenRenewal(email, async () => {
    const service = getCommentsService();

    const result = await service.createComment(email, {
      fileId: fileId as string,
      content: args.content,
      anchor: args.anchor,
      quotedFileContent,
    });

    if (!result.success) {
      throw new Error(`Failed to create comment: ${result.error}`);
    }

    const comment = result.data as CommentInfo;
    return wrapUntrustedContent(
      `Comment created successfully.\nComment ID: ${comment.commentId}\nContent: ${comment.content}\nAuthor: ${comment.author.displayName}`,
      `google-workspace:comments:doc/${fileId}`
    );
  });
}

export async function handleResolveComment(args: ResolveCommentArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  const rawArgs = args as unknown as Record<string, unknown>;
  const fileId = readAliasedString(rawArgs, 'file_id', 'fileId');
  const commentId = readAliasedString(rawArgs, 'comment_id', 'commentId');

  return await accountManager.withTokenRenewal(email, async () => {
    const service = getCommentsService();

    const result = await service.resolveComment(email, {
      fileId: fileId as string,
      commentId: commentId as string,
      action: args.action,
    });

    if (!result.success) {
      throw new Error(`Failed to ${args.action} comment: ${result.error}`);
    }

    const reply = result.data as ReplyInfo;
    return wrapUntrustedContent(
      `Comment ${args.action}d successfully.\nAction: ${reply.action}\nBy: ${reply.author.displayName}`,
      `google-workspace:comments:comment/${commentId}`
    );
  });
}

export async function handleReplyToComment(args: ReplyToCommentArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  const rawArgs = args as unknown as Record<string, unknown>;
  const fileId = readAliasedString(rawArgs, 'file_id', 'fileId');
  const commentId = readAliasedString(rawArgs, 'comment_id', 'commentId');

  return await accountManager.withTokenRenewal(email, async () => {
    const service = getCommentsService();

    const result = await service.createReply(email, {
      fileId: fileId as string,
      commentId: commentId as string,
      content: args.content,
    });

    if (!result.success) {
      throw new Error(`Failed to create reply: ${result.error}`);
    }

    const reply = result.data as ReplyInfo;
    return wrapUntrustedContent(
      `Reply created successfully.\nReply ID: ${reply.replyId}\nContent: ${reply.content}\nAuthor: ${reply.author.displayName}`,
      `google-workspace:comments:comment/${commentId}`
    );
  });
}

export async function handleDeleteComment(args: DeleteCommentArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const email = await resolveEmail(args);
  const rawArgs = args as unknown as Record<string, unknown>;
  const fileId = readAliasedString(rawArgs, 'file_id', 'fileId');
  const commentId = readAliasedString(rawArgs, 'comment_id', 'commentId');

  return await accountManager.withTokenRenewal(email, async () => {
    const service = getCommentsService();

    const result = await service.deleteComment(email, {
      fileId: fileId as string,
      commentId: commentId as string,
    });

    if (!result.success) {
      throw new Error(`Failed to delete comment: ${result.error}`);
    }

    return `Comment ${commentId} deleted successfully.`;
  });
}
