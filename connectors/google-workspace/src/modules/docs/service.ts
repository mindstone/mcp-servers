import { google, docs_v1 } from 'googleapis';
import { BaseGoogleService } from '../../services/base/BaseGoogleService.js';
import {
  DocsOperationResult,
  ReadDocumentOptions,
  CreateDocumentOptions,
  AppendDocumentOptions,
  ReplaceDocumentOptions,
  FindReplaceOptions,
  ListTabsOptions,
  BatchUpdateDocumentOptions,
  DocumentResponse,
  TabInfo,
} from './types.js';
import { DOCS_SCOPES } from './scopes.js';
import { describeApiError } from '../../utils/apiError.js';

const DEFAULT_MAX_CHARS = 50000;
const TRUNCATION_MARKER = '\n\n[TRUNCATED - document exceeds character limit]';

export class DocsService extends BaseGoogleService<docs_v1.Docs> {
  private initialized = false;

  constructor() {
    super({
      serviceName: 'Google Docs',
      version: 'v1',
    });
  }

  public async initialize(): Promise<void> {
    try {
      await super.initialize();
      this.initialized = true;
    } catch (error) {
      throw this.handleError(error, 'Failed to initialize Docs service');
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
        new Error('Docs service not initialized'),
        'Please ensure the service is initialized before use'
      );
    }
  }

  /**
   * Construct a Google Docs URL from document ID
   */
  private constructDocumentUrl(documentId: string): string {
    return `https://docs.google.com/document/d/${documentId}/edit`;
  }

  /**
   * Extract plain text from document body structure
   */
  private extractTextFromBody(body: docs_v1.Schema$Body | undefined): string {
    if (!body?.content) {
      return '';
    }

    const textParts: string[] = [];

    for (const element of body.content) {
      if (element.paragraph?.elements) {
        for (const paragraphElement of element.paragraph.elements) {
          if (paragraphElement.textRun?.content) {
            textParts.push(paragraphElement.textRun.content);
          }
        }
      } else if (element.table) {
        // Extract text from table cells
        for (const row of element.table.tableRows || []) {
          for (const cell of row.tableCells || []) {
            if (cell.content) {
              for (const cellElement of cell.content) {
                if (cellElement.paragraph?.elements) {
                  for (const pe of cellElement.paragraph.elements) {
                    if (pe.textRun?.content) {
                      textParts.push(pe.textRun.content);
                    }
                  }
                }
              }
            }
          }
          textParts.push('\n'); // Row separator
        }
      }
    }

    return textParts.join('');
  }

  /**
   * Get the end index of the document body for insert operations
   */
  private getDocumentEndIndex(doc: docs_v1.Schema$Document): number {
    const body = doc.body;
    if (!body?.content || body.content.length === 0) {
      return 1;
    }

    // Find the last structural element and get its end index
    const lastElement = body.content[body.content.length - 1];
    return (lastElement.endIndex ?? 1) - 1; // -1 to insert before final newline
  }

  /**
   * Read a document and return its content
   */
  async getDocument(
    email: string,
    documentId: string,
    options: ReadDocumentOptions = {}
  ): Promise<DocsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      // Accept either READONLY or FULL scope for read operations
      // (Google may return only FULL if both are requested)
      await this.validateScopes(email, [DOCS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.docs({ version: 'v1', auth })
      );

      const response = await client.documents.get({
        documentId,
      });

      const doc = response.data;
      const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

      // Extract text content
      let textContent = this.extractTextFromBody(doc.body);
      let truncated = false;

      if (textContent.length > maxChars) {
        textContent = textContent.substring(0, maxChars) + TRUNCATION_MARKER;
        truncated = true;
      }

      const result: DocumentResponse = {
        title: doc.title || 'Untitled',
        documentId: doc.documentId || documentId,
        documentUrl: this.constructDocumentUrl(doc.documentId || documentId),
        content: textContent,
        truncated,
        revisionId: doc.revisionId || undefined,
        // Note: tabCount/tabs not available in googleapis@129
        tabCount: 1,
      };

      return {
        success: true,
        data: options.returnJson ? doc : result,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Create a new document with optional initial content
   */
  async createDocument(
    email: string,
    options: CreateDocumentOptions
  ): Promise<DocsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [DOCS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.docs({ version: 'v1', auth })
      );

      // Create empty document
      const createResponse = await client.documents.create({
        requestBody: {
          title: options.title,
        },
      });

      const documentId = createResponse.data.documentId;
      if (!documentId) {
        return {
          success: false,
          error: 'Failed to create document - no documentId returned',
        };
      }

      // Add initial content if provided
      if (options.content) {
        await client.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                insertText: {
                  location: { index: 1 },
                  text: options.content,
                },
              },
            ],
          },
        });
      }

      const result: DocumentResponse = {
        title: options.title,
        documentId,
        documentUrl: this.constructDocumentUrl(documentId),
      };

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Append text to the end of a document
   */
  async appendToDocument(
    email: string,
    options: AppendDocumentOptions
  ): Promise<DocsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [DOCS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.docs({ version: 'v1', auth })
      );

      // First get the document to find the end index
      const docResponse = await client.documents.get({
        documentId: options.documentId,
      });

      const endIndex = this.getDocumentEndIndex(docResponse.data);

      // Append text at the end
      await client.documents.batchUpdate({
        documentId: options.documentId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { index: endIndex },
                text: options.text,
              },
            },
          ],
        },
      });

      const result: DocumentResponse = {
        title: docResponse.data.title || 'Untitled',
        documentId: options.documentId,
        documentUrl: this.constructDocumentUrl(options.documentId),
      };

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Replace entire document content
   */
  async replaceDocument(
    email: string,
    options: ReplaceDocumentOptions
  ): Promise<DocsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [DOCS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.docs({ version: 'v1', auth })
      );

      // First get the document to find the content range
      const docResponse = await client.documents.get({
        documentId: options.documentId,
      });

      const doc = docResponse.data;
      const endIndex = this.getDocumentEndIndex(doc);

      // Build requests: delete existing content (if any), then insert new
      const requests: docs_v1.Schema$Request[] = [];

      // Only delete if there's content beyond index 1
      if (endIndex > 1) {
        requests.push({
          deleteContentRange: {
            range: {
              startIndex: 1,
              endIndex: endIndex,
            },
          },
        });
      }

      // Insert new content at start
      requests.push({
        insertText: {
          location: { index: 1 },
          text: options.content,
        },
      });

      await client.documents.batchUpdate({
        documentId: options.documentId,
        requestBody: { requests },
      });

      const result: DocumentResponse = {
        title: doc.title || 'Untitled',
        documentId: options.documentId,
        documentUrl: this.constructDocumentUrl(options.documentId),
      };

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Find and replace text throughout the document
   */
  async findAndReplace(
    email: string,
    options: FindReplaceOptions
  ): Promise<DocsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [DOCS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.docs({ version: 'v1', auth })
      );

      const response = await client.documents.batchUpdate({
        documentId: options.documentId,
        requestBody: {
          requests: [
            {
              replaceAllText: {
                containsText: {
                  text: options.findText,
                  matchCase: options.matchCase ?? false,
                },
                replaceText: options.replaceText,
              },
            },
          ],
        },
      });

      // Get occurrences changed from response
      const replies = response.data.replies;
      let occurrencesChanged = 0;
      if (replies && replies[0]?.replaceAllText?.occurrencesChanged) {
        occurrencesChanged = replies[0].replaceAllText.occurrencesChanged;
      }

      // Get updated document info
      const docResponse = await client.documents.get({
        documentId: options.documentId,
        fields: 'title,documentId',
      });

      return {
        success: true,
        data: {
          title: docResponse.data.title || 'Untitled',
          documentId: options.documentId,
          documentUrl: this.constructDocumentUrl(options.documentId),
        },
        occurrencesChanged,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Batch update a document with multiple operations.
   * This is the core API for modifying documents programmatically.
   *
   * @param email - User email for authentication
   * @param documentId - ID of the document to update
   * @param options - BatchUpdateDocumentOptions containing requests array and optional writeControl
   * @returns DocsOperationResult with DocsBatchUpdateResponse data
   */
  async batchUpdate(
    email: string,
    documentId: string,
    options: BatchUpdateDocumentOptions
  ): Promise<DocsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [DOCS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.docs({ version: 'v1', auth })
      );

      const response = await client.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: options.requests,
          writeControl: options.writeControl,
        },
      });

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * List tabs in a document
   * Note: Full tab support requires googleapis upgrade. Currently returns single default tab.
   */
  async listTabs(
    email: string,
    options: ListTabsOptions
  ): Promise<DocsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      // Accept either READONLY or FULL scope for read operations
      // (Google may return only FULL if both are requested)
      await this.validateScopes(email, [DOCS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.docs({ version: 'v1', auth })
      );

      const response = await client.documents.get({
        documentId: options.documentId,
      });

      const doc = response.data;

      // Since tabs API is not available in googleapis@129,
      // return a single "default" tab representing the main document body
      let wordCount: number | undefined;
      if (options.includeWordCount) {
        const text = this.extractTextFromBody(doc.body);
        wordCount = text.split(/\s+/).filter((word) => word.length > 0).length;
      }

      const tabs: TabInfo[] = [
        {
          tabId: 'default',
          title: doc.title || 'Document',
          index: 0,
          wordCount,
        },
      ];

      return {
        success: true,
        data: tabs,
      };
    } catch (error) {
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }
}
