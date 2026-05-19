import { google, gmail_v1 } from 'googleapis';
import { 
  GmailAttachment,
  IncomingGmailAttachment,
  OutgoingGmailAttachment,
  GmailError 
} from '../types.js';
import { AttachmentIndexService } from '../../attachments/index-service.js';

type MessagePart = gmail_v1.Schema$MessagePart;

/**
 * Recursively find all attachment parts in nested MIME structures.
 * Inlined here (duplicated from email.ts) to avoid circular dependency
 * (email.ts imports from attachment.ts).
 */
function findAttachmentParts(part: MessagePart): MessagePart[] {
  const attachments: MessagePart[] = [];

  if (part.filename && part.body?.attachmentId) {
    attachments.push(part);
  }

  if (part.parts) {
    for (const subPart of part.parts) {
      attachments.push(...findAttachmentParts(subPart));
    }
  }

  return attachments;
}

export class GmailAttachmentService {
  private static instance: GmailAttachmentService;
  private indexService: AttachmentIndexService;
  private gmailClient?: ReturnType<typeof google.gmail>;

  private constructor() {
    this.indexService = AttachmentIndexService.getInstance();
  }

  /**
   * Add attachment metadata to the index
   */
  addAttachment(messageId: string, attachment: {
    id: string;
    name: string;
    mimeType: string;
    size: number;
  }): void {
    this.indexService.addAttachment(messageId, attachment);
  }

  public static getInstance(): GmailAttachmentService {
    if (!GmailAttachmentService.instance) {
      GmailAttachmentService.instance = new GmailAttachmentService();
    }
    return GmailAttachmentService.instance;
  }

  /**
   * Updates the Gmail client instance
   */
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

  /**
   * Get attachment content from Gmail.
   * Falls back to on-demand message fetch when the in-memory index misses.
   */
  async getAttachment(
    email: string,
    messageId: string,
    filename: string
  ): Promise<IncomingGmailAttachment> {
    try {
      let metadata = this.indexService.getMetadata(messageId, filename);

      if (!metadata) {
        // On-demand fallback: fetch message and find attachment by filename
        const client = this.ensureClient();
        const { data: message } = await client.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        });

        if (!message.payload) {
          throw new GmailError(
            `Message ${messageId} not found or has no content`,
            'ATTACHMENT_ERROR'
          );
        }

        const attachmentParts = findAttachmentParts(message.payload);
        // Case-insensitive filename matching
        const matchedPart = attachmentParts.find(
          p => p.filename?.toLowerCase() === filename.toLowerCase()
        );

        if (!matchedPart || !matchedPart.body?.attachmentId) {
          throw new GmailError(
            `No attachment named '${filename}' found in message ${messageId}`,
            'ATTACHMENT_ERROR',
            `Available attachments: ${attachmentParts.map(p => p.filename).filter(Boolean).join(', ') || 'none'}`
          );
        }

        // Cache ALL discovered attachments for future requests
        for (const part of attachmentParts) {
          if (part.filename && part.body?.attachmentId) {
            this.indexService.addAttachment(messageId, {
              id: part.body.attachmentId,
              name: part.filename,
              mimeType: part.mimeType || 'application/octet-stream',
              size: parseInt(String(part.body.size || '0')),
            });
          }
        }

        // Use the matched part's actual filename for index lookup (handles case mismatch
        // between user-provided filename and Gmail's stored filename)
        const canonicalFilename = matchedPart.filename!;
        metadata = this.indexService.getMetadata(messageId, canonicalFilename);
        if (!metadata) {
          throw new GmailError(
            `Failed to index attachment '${filename}' from message ${messageId}`,
            'ATTACHMENT_ERROR'
          );
        }
      }

      // Proceed with download using the metadata
      const client = this.ensureClient();
      const { data } = await client.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: metadata.originalId,
      });

      if (!data.data) {
        throw new Error('No attachment data received');
      }

      return {
        id: metadata.originalId,
        content: data.data,
        size: metadata.size,
        name: metadata.filename,
        mimeType: metadata.mimeType,
      };
    } catch (error) {
      if (error instanceof GmailError) throw error;
      throw new GmailError(
        'Failed to get attachment',
        'ATTACHMENT_ERROR',
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Validate attachment content and size
   */
  validateAttachment(attachment: OutgoingGmailAttachment): void {
    if (!attachment.content && !attachment.path) {
      throw new GmailError(
        'Invalid attachment',
        'VALIDATION_ERROR',
        'Attachment requires either "content" (base64) or "path" (local file)'
      );
    }

    // Gmail's attachment size limit is 25MB
    const MAX_SIZE = 25 * 1024 * 1024;
    if (attachment.size && attachment.size > MAX_SIZE) {
      throw new GmailError(
        'Invalid attachment',
        'VALIDATION_ERROR',
        `Attachment size ${attachment.size} exceeds maximum allowed size ${MAX_SIZE}`
      );
    }
  }

  /**
   * Prepare attachment for sending
   */
  prepareAttachment(attachment: OutgoingGmailAttachment): {
    filename: string;
    mimeType: string;
    content: string;
  } {
    this.validateAttachment(attachment);
    
    return {
      filename: attachment.name,
      mimeType: attachment.mimeType,
      content: attachment.content,
    };
  }
}
