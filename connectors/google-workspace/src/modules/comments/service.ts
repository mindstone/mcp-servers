import { google } from 'googleapis';
import { BaseGoogleService } from '../../services/base/BaseGoogleService.js';
import { describeApiError } from '../../utils/apiError.js';
import { DRIVE_SCOPES } from '../drive/scopes.js';
import {
  CommentsOperationResult,
  CommentInfo,
  ReplyInfo,
  ListCommentsOptions,
  CreateCommentOptions,
  ResolveCommentOptions,
  CreateReplyOptions,
  DeleteCommentOptions,
  DriveComment,
  DriveReply,
} from './types.js';

const DEFAULT_PAGE_SIZE = 20;

// Fields parameter for comments.list — Google API requires explicit field selection
const COMMENTS_FIELDS =
  'comments(id,content,author,createdTime,modifiedTime,resolved,anchor,quotedFileContent,' +
  'replies(id,content,author,createdTime,modifiedTime,action)),nextPageToken';

export class CommentsService extends BaseGoogleService<ReturnType<typeof google.drive>> {
  private initialized = false;

  constructor() {
    super({
      serviceName: 'Drive Comments',
      version: 'v3',
    });
  }

  public async initialize(): Promise<void> {
    try {
      await super.initialize();
      this.initialized = true;
    } catch (error) {
      throw this.handleError(error, 'Failed to initialize Comments service');
    }
  }

  public async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private checkInitialized(): void {
    if (!this.initialized) {
      throw this.handleError(
        new Error('Comments service not initialized'),
        'Please ensure the service is initialized before use'
      );
    }
  }

  /**
   * Map a Google API Comment to our CommentInfo type
   */
  private mapComment(comment: DriveComment): CommentInfo {
    return {
      commentId: comment.id || '',
      content: comment.content || '',
      author: {
        displayName: comment.author?.displayName || 'Unknown',
        emailAddress: comment.author?.emailAddress || undefined,
      },
      createdTime: comment.createdTime || '',
      modifiedTime: comment.modifiedTime || '',
      resolved: comment.resolved ?? false,
      replies: comment.replies?.map((reply) => this.mapReply(reply)),
      anchor: comment.anchor || undefined,
      quotedFileContent: comment.quotedFileContent
        ? {
            mimeType: comment.quotedFileContent.mimeType || '',
            value: comment.quotedFileContent.value || '',
          }
        : undefined,
    };
  }

  /**
   * Map a Google API Reply to our ReplyInfo type
   */
  private mapReply(reply: DriveReply): ReplyInfo {
    return {
      replyId: reply.id || '',
      content: reply.content || '',
      author: {
        displayName: reply.author?.displayName || 'Unknown',
        emailAddress: reply.author?.emailAddress || undefined,
      },
      createdTime: reply.createdTime || '',
      modifiedTime: reply.modifiedTime || '',
      action: reply.action || undefined,
    };
  }

  /**
   * List comments on a Drive file
   */
  async listComments(
    email: string,
    options: ListCommentsOptions
  ): Promise<CommentsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.drive({ version: 'v3', auth })
      );

      const response = await client.comments.list({
        fileId: options.fileId,
        pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
        pageToken: options.pageToken || undefined,
        includeDeleted: options.includeDeleted ?? false,
        fields: COMMENTS_FIELDS,
      });

      const comments = (response.data.comments || []).map((c) => this.mapComment(c));

      return {
        success: true,
        data: comments,
        nextPageToken: response.data.nextPageToken || undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Create a comment on a Drive file
   */
  async createComment(
    email: string,
    options: CreateCommentOptions
  ): Promise<CommentsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.drive({ version: 'v3', auth })
      );

      const requestBody: DriveComment = {
        content: options.content,
      };

      if (options.anchor) {
        requestBody.anchor = options.anchor;
      }

      if (options.quotedFileContent) {
        requestBody.quotedFileContent = {
          mimeType: options.quotedFileContent.mimeType,
          value: options.quotedFileContent.value,
        };
      }

      const response = await client.comments.create({
        fileId: options.fileId,
        requestBody,
        fields: 'id,content,author,createdTime,modifiedTime,resolved,anchor,quotedFileContent',
      });

      return {
        success: true,
        data: this.mapComment(response.data),
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Resolve or reopen a comment by creating a reply with an action
   */
  async resolveComment(
    email: string,
    options: ResolveCommentOptions
  ): Promise<CommentsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.drive({ version: 'v3', auth })
      );

      const response = await client.replies.create({
        fileId: options.fileId,
        commentId: options.commentId,
        requestBody: {
          content: options.action === 'resolve' ? 'Resolved' : 'Reopened',
          action: options.action,
        },
        fields: 'id,content,author,createdTime,modifiedTime,action',
      });

      return {
        success: true,
        data: this.mapReply(response.data),
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Create a reply to an existing comment
   */
  async createReply(
    email: string,
    options: CreateReplyOptions
  ): Promise<CommentsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.drive({ version: 'v3', auth })
      );

      const response = await client.replies.create({
        fileId: options.fileId,
        commentId: options.commentId,
        requestBody: {
          content: options.content,
        },
        fields: 'id,content,author,createdTime,modifiedTime,action',
      });

      return {
        success: true,
        data: this.mapReply(response.data),
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Delete a comment (can only delete own comments)
   */
  async deleteComment(
    email: string,
    options: DeleteCommentOptions
  ): Promise<CommentsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [DRIVE_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.drive({ version: 'v3', auth })
      );

      await client.comments.delete({
        fileId: options.fileId,
        commentId: options.commentId,
      });

      return {
        success: true,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }
}
