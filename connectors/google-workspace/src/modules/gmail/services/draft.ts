
import { google } from 'googleapis';
import { 
  GmailError, 
  OutgoingGmailAttachment,
  IncomingGmailAttachment 
} from '../types.js';
import { GmailAttachmentService } from './attachment.js';
import { buildMimeMessage } from './mime-builder.js';
import { describeApiError } from '../../../utils/apiError.js';
import logger from '../../../utils/logger.js';

export type DraftAction = 'create' | 'read' | 'update' | 'delete' | 'send';

export interface ManageDraftParams {
  email: string;
  action: DraftAction;
  draftId?: string;
  data?: DraftData;
}

export interface DraftData {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  isHtml?: boolean;
  threadId?: string;      // For reply drafts
  inReplyTo?: string;     // Message-ID of email being replied to
  references?: string[];  // Chain of Message-IDs for threading
  attachments?: OutgoingGmailAttachment[];
}

export class DraftService {
  private gmailClient?: ReturnType<typeof google.gmail>;
  constructor(private attachmentService: GmailAttachmentService) {}

  async initialize(): Promise<void> {
    // Initialization will be handled by Gmail service
  }

  updateClient(client: ReturnType<typeof google.gmail>) {
    this.gmailClient = client;
  }

  private ensureClient(): ReturnType<typeof google.gmail> {
    if (!this.gmailClient) {
      throw new GmailError(
        'Gmail client not initialized',
        'CLIENT_ERROR',
        'Please ensure the service is initialized'
      );
    }
    return this.gmailClient;
  }

  async createDraft(email: string, data: DraftData) {
    try {
      const client = this.ensureClient();

      const processedAttachments = data.attachments?.map(attachment => {
        this.attachmentService.validateAttachment(attachment);
        return this.attachmentService.prepareAttachment(attachment);
      }) || [];

      const encodedMessage = buildMimeMessage({
        to: data.to,
        subject: data.subject,
        body: data.body,
        cc: data.cc,
        bcc: data.bcc,
        isHtml: data.isHtml,
        inReplyTo: data.inReplyTo,
        references: data.references,
        attachments: processedAttachments.map(a => ({
          filename: a.filename,
          mimeType: a.mimeType,
          content: a.content,
        })),
      });

      const { data: draft } = await client.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: encodedMessage,
            threadId: data.threadId // Include threadId for replies
          }
        }
      });

      return {
        id: draft.id || '',
        message: {
          id: draft.message?.id || '',
          threadId: draft.message?.threadId || '',
          labelIds: draft.message?.labelIds || []
        },
        updated: new Date().toISOString(),
        attachments: data.attachments
      };
    } catch (error) {
      const details = describeApiError(error);
      logger.warn(`Failed to create draft: ${details}`);
      throw new GmailError(
        'Failed to create draft',
        'CREATE_ERROR',
        details
      );
    }
  }

  async listDrafts(email: string) {
    try {
      const client = this.ensureClient();
      const { data } = await client.users.drafts.list({
        userId: 'me'
      });

      // Get full details for each draft
      const drafts = await Promise.all((data.drafts || [])
        .filter((draft): draft is { id: string } => typeof draft.id === 'string')
        .map(async draft => {
          try {
            return await this.getDraft(email, draft.id);
          } catch (error) {
            // Log error but continue with other drafts
            logger.warn(`Failed to get draft ${draft.id}:`, error);
            return null;
          }
        })
      );

      // Filter out any failed draft fetches
      const successfulDrafts = drafts.filter((draft): draft is NonNullable<typeof draft> => draft !== null);

      return {
        drafts: successfulDrafts,
        nextPageToken: data.nextPageToken || undefined,
        resultSizeEstimate: data.resultSizeEstimate || 0
      };
    } catch (error) {
      throw new GmailError(
        'Failed to list drafts',
        'LIST_ERROR',
        describeApiError(error)
      );
    }
  }

  async getDraft(email: string, draftId: string) {
    try {
      const client = this.ensureClient();
      const { data } = await client.users.drafts.get({
        userId: 'me',
        id: draftId,
        format: 'full'
      });

      if (!data.id || !data.message?.id || !data.message?.threadId) {
        throw new GmailError(
          'Invalid response from Gmail API',
          'GET_ERROR',
          'Message ID or Thread ID is missing'
        );
      }

      return {
        id: data.id,
        message: {
          id: data.message.id,
          threadId: data.message.threadId,
          labelIds: data.message.labelIds || []
        },
        updated: new Date().toISOString() // Gmail API doesn't provide updated time, using current time
      };
    } catch (error) {
      throw new GmailError(
        'Failed to get draft',
        'GET_ERROR',
        describeApiError(error)
      );
    }
  }

  async updateDraft(email: string, draftId: string, data: DraftData) {
    try {
      const client = this.ensureClient();

      // Preserve the existing draft's thread on body-only updates. Gmail's
      // drafts.update REPLACES the draft message, and an omitted threadId
      // detaches the draft from its conversation — so a body-only update
      // (caller passed no thread_id and no reply_to_message_id) would
      // silently unthread the draft. Fetch the existing draft first and keep
      // its threadId; an explicit threadId (reply threading resolved at the
      // handler layer) still wins.
      let threadId = data.threadId;
      if (threadId === undefined) {
        try {
          const existing = await this.getDraft(email, draftId);
          threadId = existing.message.threadId;
        } catch (error) {
          // Observable degradation, not a new failure mode: the update still
          // proceeds as before (unthreaded) rather than failing an operation
          // that used to succeed — but the degradation is logged, not silent.
          const cause = error instanceof Error ? error.message : error;
          const detail =
            error instanceof GmailError && error.details ? `${cause} (${error.details})` : cause;
          logger.warn(
            `Failed to fetch draft ${draftId} for thread preservation; updating without a threadId:`,
            detail,
          );
        }
      }

      // Validate and prepare attachments
      const processedAttachments = data.attachments?.map(attachment => {
        this.attachmentService.validateAttachment(attachment);
        return this.attachmentService.prepareAttachment(attachment);
      }) || [];

      const encodedMessage = buildMimeMessage({
        to: data.to,
        subject: data.subject,
        body: data.body,
        cc: data.cc,
        bcc: data.bcc,
        isHtml: data.isHtml,
        inReplyTo: data.inReplyTo,
        references: data.references,
        attachments: processedAttachments.map(a => ({
          filename: a.filename,
          mimeType: a.mimeType,
          content: a.content,
        })),
      });

      const { data: draft } = await client.users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: {
          message: {
            raw: encodedMessage,
            threadId // Preserved from the existing draft unless explicitly overridden
          }
        }
      });

      return {
        id: draft.id || '',
        message: {
          id: draft.message?.id || '',
          threadId: draft.message?.threadId || '',
          labelIds: draft.message?.labelIds || []
        },
        updated: new Date().toISOString(),
        attachments: data.attachments
      };
    } catch (error) {
      const details = describeApiError(error);
      logger.warn(`Failed to update draft ${draftId}: ${details}`);
      throw new GmailError(
        'Failed to update draft',
        'UPDATE_ERROR',
        details
      );
    }
  }

  async deleteDraft(email: string, draftId: string) {
    try {
      const client = this.ensureClient();
      await client.users.drafts.delete({
        userId: 'me',
        id: draftId
      });

      return;
    } catch (error) {
      throw new GmailError(
        'Failed to delete draft',
        'DELETE_ERROR',
        describeApiError(error)
      );
    }
  }

  async manageDraft(params: ManageDraftParams) {
    const { email, action, draftId, data } = params;

    switch (action) {
      case 'create':
        if (!data) {
          throw new GmailError(
            'Draft data is required for create action',
            'INVALID_PARAMS'
          );
        }
        return this.createDraft(email, data);

      case 'read':
        if (!draftId) {
          return this.listDrafts(email);
        }
        return this.getDraft(email, draftId);

      case 'update':
        if (!draftId || !data) {
          throw new GmailError(
            'Draft ID and data are required for update action',
            'INVALID_PARAMS'
          );
        }
        return this.updateDraft(email, draftId, data);

      case 'delete':
        if (!draftId) {
          throw new GmailError(
            'Draft ID is required for delete action',
            'INVALID_PARAMS'
          );
        }
        return this.deleteDraft(email, draftId);

      case 'send':
        if (!draftId) {
          throw new GmailError(
            'Draft ID is required for send action',
            'INVALID_PARAMS'
          );
        }
        return this.sendDraft(email, draftId);

      default:
        throw new GmailError(
          'Invalid action',
          'INVALID_PARAMS',
          'Supported actions are: create, read, update, delete, send'
        );
    }
  }

  async sendDraft(email: string, draftId: string) {
    try {
      const client = this.ensureClient();
      const { data } = await client.users.drafts.send({
        userId: 'me',
        requestBody: {
          id: draftId
        }
      });

      if (!data.id || !data.threadId) {
        throw new GmailError(
          'Invalid response from Gmail API',
          'SEND_ERROR',
          'Message ID or Thread ID is missing'
        );
      }
      
      return {
        messageId: data.id,
        threadId: data.threadId,
        labelIds: data.labelIds || undefined
      };
    } catch (error) {
      throw new GmailError(
        'Failed to send draft',
        'SEND_ERROR',
        describeApiError(error)
      );
    }
  }
}
