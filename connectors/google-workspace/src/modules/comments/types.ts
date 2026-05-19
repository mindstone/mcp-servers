import { drive_v3 } from 'googleapis';

// Re-export Google API types for convenience
export type DriveComment = drive_v3.Schema$Comment;
export type DriveReply = drive_v3.Schema$Reply;

export interface CommentInfo {
  commentId: string;
  content: string;
  author: { displayName: string; emailAddress?: string };
  createdTime: string;
  modifiedTime: string;
  resolved: boolean;
  replies?: ReplyInfo[];
  anchor?: string;
  quotedFileContent?: { mimeType: string; value: string };
}

export interface ReplyInfo {
  replyId: string;
  content: string;
  author: { displayName: string; emailAddress?: string };
  createdTime: string;
  modifiedTime: string;
  action?: string; // 'resolve' or 'reopen'
}

export interface ListCommentsOptions {
  fileId: string;
  pageSize?: number; // default 20
  pageToken?: string;
  includeDeleted?: boolean;
}

export interface CreateCommentOptions {
  fileId: string;
  content: string;
  anchor?: string; // file-type-specific JSON anchor
  quotedFileContent?: { mimeType: string; value: string };
}

export interface ResolveCommentOptions {
  fileId: string;
  commentId: string;
  action: 'resolve' | 'reopen';
}

export interface CreateReplyOptions {
  fileId: string;
  commentId: string;
  content: string;
}

export interface DeleteCommentOptions {
  fileId: string;
  commentId: string;
}

export interface CommentsOperationResult {
  success: boolean;
  data?: CommentInfo | CommentInfo[] | ReplyInfo;
  error?: string;
  nextPageToken?: string;
}
