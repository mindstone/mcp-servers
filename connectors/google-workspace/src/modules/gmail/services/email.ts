import { google, gmail_v1 } from 'googleapis';
import {
  EmailResponse,
  GetEmailsParams,
  GetEmailsResponse,
  SendEmailParams,
  SendEmailResponse,
  ThreadInfo,
  GmailError,
  IncomingGmailAttachment,
  OutgoingGmailAttachment
} from '../types.js';
import { SearchService } from './search.js';
import { GmailAttachmentService } from './attachment.js';
import { buildMimeMessage } from './mime-builder.js';
import { AttachmentResponseTransformer } from '../../attachments/response-transformer.js';
import { AttachmentIndexService } from '../../attachments/index-service.js';

type GmailMessage = gmail_v1.Schema$Message;

type MessagePart = gmail_v1.Schema$MessagePart;

/**
 * Recursively find text/plain or text/html body in nested MIME parts.
 * Handles multipart/alternative and multipart/mixed structures.
 */
function findBodyPart(part: MessagePart, preferHtml = false): MessagePart | undefined {
  // Direct match
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return part;
  }
  if (part.mimeType === 'text/html' && part.body?.data && preferHtml) {
    return part;
  }
  
  // Search nested parts
  if (part.parts) {
    // For multipart/alternative, prefer text/plain unless HTML requested
    let textPart: MessagePart | undefined;
    let htmlPart: MessagePart | undefined;
    
    for (const subPart of part.parts) {
      const found = findBodyPart(subPart, preferHtml);
      if (found) {
        if (found.mimeType === 'text/plain') {
          textPart = found;
        } else if (found.mimeType === 'text/html') {
          htmlPart = found;
        }
      }
    }
    
    // Return preferred format
    if (preferHtml && htmlPart) return htmlPart;
    if (textPart) return textPart;
    if (htmlPart) return htmlPart;
  }
  
  return undefined;
}

/**
 * Recursively find all attachments in nested MIME parts.
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

export class EmailService {
  private responseTransformer: AttachmentResponseTransformer;

  constructor(
    private searchService: SearchService,
    private attachmentService: GmailAttachmentService,
    private gmailClient?: ReturnType<typeof google.gmail>
  ) {
    this.responseTransformer = new AttachmentResponseTransformer(AttachmentIndexService.getInstance());
  }

  /**
   * Updates the Gmail client instance
   * @param client - New Gmail client instance
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
   * Extracts all headers into a key-value map
   */
  private extractHeaders(headers: { name: string; value: string }[]): { [key: string]: string } {
    return headers.reduce((acc, header) => {
      acc[header.name] = header.value;
      return acc;
    }, {} as { [key: string]: string });
  }

  /**
   * Groups emails by thread ID and extracts thread information
   */
  private groupEmailsByThread(emails: EmailResponse[]): { [threadId: string]: ThreadInfo } {
    return emails.reduce((threads, email) => {
      if (!threads[email.threadId]) {
        threads[email.threadId] = {
          messages: [],
          participants: [],
          subject: email.subject,
          lastUpdated: email.date
        };
      }

      const thread = threads[email.threadId];
      thread.messages.push(email.id);
      
      if (!thread.participants.includes(email.from)) {
        thread.participants.push(email.from);
      }
      if (email.to && !thread.participants.includes(email.to)) {
        thread.participants.push(email.to);
      }
      
      const emailDate = new Date(email.date);
      const threadDate = new Date(thread.lastUpdated);
      if (emailDate > threadDate) {
        thread.lastUpdated = email.date;
      }

      return threads;
    }, {} as { [threadId: string]: ThreadInfo });
  }

  /**
   * Get a single message by ID with headers (used for reply threading)
   */
  async getMessage(accountEmail: string, messageId: string): Promise<{
    id: string;
    threadId: string;
    headers?: Array<{ name: string; value: string }>;
  } | null> {
    try {
      const client = this.ensureClient();
      const { data } = await client.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References', 'In-Reply-To'],
      });

      if (!data.id || !data.threadId) {
        return null;
      }

      return {
        id: data.id,
        threadId: data.threadId,
        headers: data.payload?.headers?.map(h => ({
          name: h.name || '',
          value: h.value || ''
        }))
      };
    } catch {
      return null;
    }
  }

  /**
   * Get all messages in a thread (for full conversation context)
   */
  async getThread(
    accountEmail: string,
    threadId: string,
    options: { maxMessages?: number; offset?: number; includeBody?: boolean } = {}
  ): Promise<{
    threadId: string;
    messagesCount: number;
    hasMore?: boolean;
    nextOffset?: number;
    messages: Array<{
      id: string;
      date: string;
      from: string;
      to: string[];
      cc?: string[];
      subject: string;
      snippet?: string;
      body?: { text?: string; html?: string };
      attachments?: Array<{ id: string; filename: string; mimeType: string; size: number }>;
    }>;
  }> {
    const { maxMessages = 50, offset = 0, includeBody = true } = options;
    
    try {
      const client = this.ensureClient();
      const { data } = await client.users.threads.get({
        userId: 'me',
        id: threadId,
        format: includeBody ? 'full' : 'metadata',
      });

      if (!data.messages || data.messages.length === 0) {
        return {
          threadId,
          messagesCount: 0,
          messages: []
        };
      }

      // Apply offset and limit
      const messagesToProcess = data.messages.slice(offset, offset + maxMessages);

      const messages = messagesToProcess.map(msg => {
        const headers = msg.payload?.headers || [];
        const getHeader = (name: string) => 
          headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

        const from = getHeader('from');
        const toHeader = getHeader('to');
        const ccHeader = getHeader('cc');
        const subject = getHeader('subject');
        const date = getHeader('date');

        const to = toHeader.split(',').map(e => e.trim()).filter(Boolean);
        const cc = ccHeader ? ccHeader.split(',').map(e => e.trim()).filter(Boolean) : undefined;

        // Extract body if requested
        let body: { text?: string; html?: string } | undefined;
        if (includeBody && msg.payload) {
          const textBodyPart = findBodyPart(msg.payload, false);
          const htmlBodyPart = findBodyPart(msg.payload, true);
          body = {
            text: textBodyPart?.body?.data ? Buffer.from(textBodyPart.body.data, 'base64').toString() : undefined,
            html: htmlBodyPart?.body?.data ? Buffer.from(htmlBodyPart.body.data, 'base64').toString() : undefined
          };
        }

        // Extract attachment metadata
        const attachmentParts = msg.payload ? findAttachmentParts(msg.payload) : [];
        const attachments = attachmentParts.length > 0 ? attachmentParts.map(part => ({
          id: part.body?.attachmentId || '',
          filename: part.filename || 'unnamed',
          mimeType: part.mimeType || 'application/octet-stream',
          size: part.body?.size || 0
        })) : undefined;

        // Populate attachment index so download_workspace_attachment works
        // after viewing a thread (mirrors what getEmails() does)
        if (attachments && msg.id) {
          attachments.forEach(att => {
            this.attachmentService.addAttachment(msg.id!, {
              id: att.id,
              name: att.filename,
              mimeType: att.mimeType,
              size: att.size,
            });
          });
        }

        return {
          id: msg.id!,
          date,
          from,
          to,
          cc: cc && cc.length > 0 ? cc : undefined,
          subject,
          snippet: msg.snippet || undefined,
          body,
          attachments
        };
      });

      // Sort by date (oldest first for conversation view)
      messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      const totalMessages = data.messages.length;
      const hasMore = offset + maxMessages < totalMessages;

      return {
        threadId,
        messagesCount: totalMessages,
        ...(offset > 0 || hasMore ? { hasMore, nextOffset: hasMore ? offset + maxMessages : undefined } : {}),
        messages
      };
    } catch (error) {
      throw new GmailError(
        `Failed to get thread ${threadId}`,
        'THREAD_ERROR',
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Enhanced getEmails method with support for advanced search criteria and options
   */
  async getEmails({ email, search = {}, options = {}, messageIds }: GetEmailsParams): Promise<GetEmailsResponse> {
    try {
      const maxResults = options.maxResults || 10;
      
      let messages;
      let nextPageToken: string | undefined;
      
      if (messageIds && messageIds.length > 0) {
        messages = { messages: messageIds.map(id => ({ id })) };
      } else {
        // Build search query from criteria
        const query = this.searchService.buildSearchQuery(search);
        
        // List messages matching query
        const client = this.ensureClient();
        const { data } = await client.users.messages.list({
          userId: 'me',
          q: query,
          maxResults,
          pageToken: options.pageToken,
        });
        
        messages = data;
        nextPageToken = data.nextPageToken || undefined;
      }

      if (!messages.messages || messages.messages.length === 0) {
        return {
          emails: [],
          resultSummary: {
            total: 0,
            returned: 0,
            hasMore: false,
            searchCriteria: search
          }
        };
      }

      // Get full message details
      const emails = await Promise.all(
        messages.messages.map(async (message) => {
          const client = this.ensureClient();
          // Always use 'full' format to reliably detect attachments.
          // The 'metadata' format omits payload.parts[].body.attachmentId,
          // which prevents attachment detection in search results.
          const effectiveFormat = options.format || 'full';
          const { data: email } = await client.users.messages.get({
            userId: 'me',
            id: message.id!,
            format: effectiveFormat,
          });

          const headers = (email.payload?.headers || []).map(h => ({
            name: h.name || '',
            value: h.value || ''
          }));
          const subject = headers.find(h => h.name === 'Subject')?.value || '';
          const from = headers.find(h => h.name === 'From')?.value || '';
          const to = headers.find(h => h.name === 'To')?.value || '';
          const date = headers.find(h => h.name === 'Date')?.value || '';

          // Get email body using recursive search through MIME parts.
          // Only decode body when requested -- the 'full' format is always used
          // for reliable attachment detection, but body text is gated separately.
          let body = '';
          if (options.includeBody) {
            if (email.payload?.body?.data) {
              body = Buffer.from(email.payload.body.data, 'base64').toString();
            } else if (email.payload) {
              const bodyPart = findBodyPart(email.payload);
              if (bodyPart?.body?.data) {
                body = Buffer.from(bodyPart.body.data, 'base64').toString();
              }
            }
          }

          // Get attachment metadata using recursive search through MIME parts
          let attachments: IncomingGmailAttachment[] | undefined;
          if (email.payload) {
            const attachmentParts = findAttachmentParts(email.payload);
            if (attachmentParts.length > 0) {
              attachments = attachmentParts.map(part => ({
                id: part.body!.attachmentId!,
                name: part.filename!,
                mimeType: part.mimeType || 'application/octet-stream',
                size: parseInt(String(part.body?.size || '0'))
              }));
              // Store each attachment's metadata in the index
              attachments.forEach(attachment => {
                this.attachmentService.addAttachment(email.id!, attachment);
              });
            }
          }
          const hasAttachments = (attachments?.length || 0) > 0;

          const response: EmailResponse = {
            id: email.id!,
            threadId: email.threadId!,
            labelIds: email.labelIds || undefined,
            snippet: email.snippet || undefined,
            subject,
            from,
            to,
            date,
            body,
            headers: options.includeHeaders ? this.extractHeaders(headers) : undefined,
            isUnread: email.labelIds?.includes('UNREAD') || false,
            hasAttachment: hasAttachments,
            attachments
          };

          return response;
        })
      );

      // Handle threaded view if requested
      const threads = options.threadedView ? this.groupEmailsByThread(emails) : undefined;

      // Sort emails if requested
      if (options.sortOrder) {
        emails.sort((a, b) => {
          const dateA = new Date(a.date).getTime();
          const dateB = new Date(b.date).getTime();
          return options.sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
        });
      }

      // Transform response to simplify attachments
      const transformedResponse = this.responseTransformer.transformResponse({
        emails,
        nextPageToken,
        resultSummary: {
          total: messages.resultSizeEstimate || emails.length,
          returned: emails.length,
          hasMore: Boolean(nextPageToken),
          searchCriteria: search
        },
        threads
      });

      return transformedResponse;
    } catch (error) {
      if (error instanceof GmailError) {
        throw error;
      }
      throw new GmailError(
        'Failed to get emails',
        'FETCH_ERROR',
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Move a message to the trash
   */
  async trashMessage(email: string, messageId: string): Promise<void> {
    const client = this.ensureClient();
    await client.users.messages.trash({ userId: 'me', id: messageId });
  }

  /**
   * Remove a message from the trash
   */
  async untrashMessage(email: string, messageId: string): Promise<void> {
    const client = this.ensureClient();
    await client.users.messages.untrash({ userId: 'me', id: messageId });
  }

  async sendEmail({ email, to, subject, body, cc = [], bcc = [], isHtml = false, attachments = [], threadId, inReplyTo, references }: SendEmailParams): Promise<SendEmailResponse> {
    try {
      const processedAttachments = attachments?.map(attachment => {
        this.attachmentService.validateAttachment(attachment);
        const prepared = this.attachmentService.prepareAttachment(attachment);
        return {
          id: attachment.id,
          name: prepared.filename,
          mimeType: prepared.mimeType,
          size: attachment.size,
          content: prepared.content
        } as OutgoingGmailAttachment;
      }) || [];

      const encodedMessage = buildMimeMessage({
        to,
        subject,
        body,
        cc,
        bcc,
        isHtml,
        inReplyTo,
        references,
        attachments: processedAttachments.map(a => ({
          filename: a.name,
          mimeType: a.mimeType,
          content: a.content,
        })),
      });

      const client = this.ensureClient();
      const { data } = await client.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId,
        },
      });

      const response: SendEmailResponse = {
        messageId: data.id!,
        threadId: data.threadId!,
        labelIds: data.labelIds || undefined
      };

      if (processedAttachments.length > 0) {
        response.attachments = processedAttachments;
      }

      return response;
    } catch (error) {
      if (error instanceof GmailError) {
        throw error;
      }
      throw new GmailError(
        'Failed to send email',
        'SEND_ERROR',
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
