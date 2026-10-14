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
  TabJsonResponse,
  TabListResponse,
} from './types.js';
import { DOCS_SCOPES } from './scopes.js';
import { describeApiError, isAuthHandoffError } from '../../utils/apiError.js';
import { wrapUntrustedJsonStrings } from '../../utils/untrusted-content.js';
import {
  DocsInputError,
  FlatTab,
  TAB_TREE_FIELDS,
  TRUNCATION_MARKER,
  buildAllTabsText,
  bodyEndIndex,
  countWords,
  extractBodyText,
  flattenTabs,
  requireTabs,
  resolveTab,
} from './tabs.js';

const DEFAULT_MAX_CHARS = 50000;
/** Cap on `read_workspace_document` with `tab_id` + `return_json` (enveloped size). */
export const MAX_TAB_JSON_CHARS = 100_000;

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
    return extractBodyText(body);
  }

  /**
   * Get the end index of the document body for insert operations
   */
  private getDocumentEndIndex(doc: docs_v1.Schema$Document): number {
    return bodyEndIndex(doc.body);
  }

  /**
   * Full read of every tab's content, flattened in tree order.
   */
  private async readAllTabs(
    client: docs_v1.Docs,
    documentId: string
  ): Promise<{ doc: docs_v1.Schema$Document; flat: FlatTab[] }> {
    const response = await client.documents.get({ documentId, includeTabsContent: true });
    return { doc: response.data, flat: flattenTabs(requireTabs(response.data)) };
  }

  /**
   * Tree-only read (tab properties, no content).
   */
  private async readTabTree(
    client: docs_v1.Docs,
    documentId: string
  ): Promise<{ doc: docs_v1.Schema$Document; flat: FlatTab[] }> {
    const response = await client.documents.get({
      documentId,
      includeTabsContent: true,
      fields: TAB_TREE_FIELDS,
    });
    return { doc: response.data, flat: flattenTabs(requireTabs(response.data)) };
  }

  private toTabInfo(tab: FlatTab, wordCount?: number): TabInfo {
    return {
      tabId: tab.tabId,
      title: tab.title,
      index: tab.index,
      ...(wordCount !== undefined ? { wordCount } : {}),
      parentTabId: tab.parentTabId,
      nestingLevel: tab.nestingLevel,
      path: tab.path,
      childCount: tab.childCount,
    };
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

      if (options.tabId !== undefined || options.allTabs) {
        return await this.getDocumentTabs(client, documentId, options);
      }

      if (options.returnJson) {
        // Raw JSON without a tab argument: today's single read (top-level body = first tab).
        const response = await client.documents.get({
          documentId,
        });
        return {
          success: true,
          data: response.data,
        };
      }

      // Text read of the first tab (today's request and extraction) plus a
      // tree-only read, in parallel, for the tab count.
      const [response, tree] = await Promise.all([
        client.documents.get({
          documentId,
        }),
        this.readTabTree(client, documentId),
      ]);

      const doc = response.data;
      const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

      // Extract text content
      let textContent = this.extractTextFromBody(doc.body);
      let truncated = false;

      if (textContent.length > maxChars) {
        textContent = textContent.substring(0, maxChars) + TRUNCATION_MARKER;
        truncated = true;
      }

      const firstTab = tree.flat.find((tab) => tab.nestingLevel === 0);
      const result: DocumentResponse = {
        title: doc.title || 'Untitled',
        documentId: doc.documentId || documentId,
        documentUrl: this.constructDocumentUrl(doc.documentId || documentId),
        content: textContent,
        truncated,
        revisionId: doc.revisionId || undefined,
        tabCount: tree.flat.length,
        ...(firstTab ? { shownTab: { tabId: firstTab.tabId, title: firstTab.title } } : {}),
      };

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      // An expired/revoked grant must keep its reconnect signal — folding it
      // into a plain error string would skip the host's auth_required handoff.
      if (isAuthHandoffError(error)) throw error;
      if (error instanceof DocsInputError) throw error;
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * `tab_id` / `all_tabs` reads: one full `includeTabsContent` read, then the
   * requested tab (text or bounded JSON) or every tab under one text budget.
   */
  private async getDocumentTabs(
    client: docs_v1.Docs,
    documentId: string,
    options: ReadDocumentOptions
  ): Promise<DocsOperationResult> {
    if (options.allTabs && options.returnJson) {
      throw new DocsInputError(
        'all_tabs with return_json would return the whole document as raw JSON (often several MB). Use text mode, or tab_id with return_json for one tab.'
      );
    }

    const { doc, flat } = await this.readAllTabs(client, documentId);
    const resolvedId = doc.documentId || documentId;
    const title = doc.title || 'Untitled';
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

    if (options.allTabs) {
      const { content, truncated } = buildAllTabsText(flat, maxChars);
      const result: DocumentResponse = {
        title,
        documentId: resolvedId,
        documentUrl: this.constructDocumentUrl(resolvedId),
        content,
        truncated,
        revisionId: doc.revisionId || undefined,
        tabCount: flat.length,
      };
      return { success: true, data: result };
    }

    const tab = resolveTab(flat, options.tabId as string, { allowDefault: true });

    if (options.returnJson) {
      // One tab only; its sub-tabs are listed by id/title, not inlined.
      const payload: TabJsonResponse = {
        documentId: resolvedId,
        title,
        ...(doc.revisionId ? { revisionId: doc.revisionId } : {}),
        tab: {
          tabProperties: tab.tab.tabProperties,
          documentTab: tab.tab.documentTab,
        },
        childTabs: (tab.tab.childTabs ?? []).map((child) => ({
          tabId: child.tabProperties?.tabId ?? '',
          title: child.tabProperties?.title ?? '',
        })),
      };
      // Measure what the handler returns (strings enveloped with the same source).
      const size = JSON.stringify(
        wrapUntrustedJsonStrings(payload, `google-workspace:docs:document/${documentId}`)
      ).length;
      if (size > MAX_TAB_JSON_CHARS) {
        throw new DocsInputError(
          `This tab's JSON is ${size} characters, over the ${MAX_TAB_JSON_CHARS} limit for return_json. ` +
            'Read it as text (omit return_json), or edit it with insert_workspace_document_text or find_and_replace_workspace_document.'
        );
      }
      return { success: true, data: payload };
    }

    let textContent = extractBodyText(tab.tab.documentTab?.body, { renderInline: true });
    let truncated = false;
    if (textContent.length > maxChars) {
      textContent = textContent.substring(0, maxChars) + TRUNCATION_MARKER;
      truncated = true;
    }

    const result: DocumentResponse = {
      title,
      documentId: resolvedId,
      documentUrl: this.constructDocumentUrl(resolvedId),
      content: textContent,
      truncated,
      revisionId: doc.revisionId || undefined,
      tabCount: flat.length,
      requestedTab: { tabId: tab.tabId, title: tab.title, path: tab.path, childCount: tab.childCount },
    };
    return { success: true, data: result };
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
      // An expired/revoked grant must keep its reconnect signal — folding it
      // into a plain error string would skip the host's auth_required handoff.
      if (isAuthHandoffError(error)) throw error;
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Append text to the end of a document (the first tab, or `tabId`'s tab)
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

      if (options.tabId !== undefined) {
        const { doc, flat } = await this.readAllTabs(client, options.documentId);
        const tab = resolveTab(flat, options.tabId, { allowDefault: true });
        const endIndex = bodyEndIndex(tab.tab.documentTab?.body);

        await client.documents.batchUpdate({
          documentId: options.documentId,
          requestBody: {
            requests: [
              {
                insertText: {
                  location: { index: endIndex, tabId: tab.tabId },
                  text: options.text,
                },
              },
            ],
          },
        });

        const result: DocumentResponse = {
          title: doc.title || 'Untitled',
          documentId: options.documentId,
          documentUrl: this.constructDocumentUrl(options.documentId),
          requestedTab: { tabId: tab.tabId, title: tab.title, path: tab.path },
        };
        return { success: true, data: result };
      }

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
      // An expired/revoked grant must keep its reconnect signal — folding it
      // into a plain error string would skip the host's auth_required handoff.
      if (isAuthHandoffError(error)) throw error;
      if (error instanceof DocsInputError) throw error;
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Delete-then-insert requests that replace a body's content.
   */
  private buildReplaceRequests(
    endIndex: number,
    content: string,
    tabId?: string
  ): docs_v1.Schema$Request[] {
    // Build requests: delete existing content (if any), then insert new
    const requests: docs_v1.Schema$Request[] = [];

    // Only delete if there's content beyond index 1
    if (endIndex > 1) {
      requests.push({
        deleteContentRange: {
          range: {
            startIndex: 1,
            endIndex: endIndex,
            ...(tabId !== undefined ? { tabId } : {}),
          },
        },
      });
    }

    // Insert new content at start
    requests.push({
      insertText: {
        location: { index: 1, ...(tabId !== undefined ? { tabId } : {}) },
        text: content,
      },
    });

    return requests;
  }

  /**
   * Replace the content of the first tab, or of `tabId`'s tab
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

      if (options.tabId !== undefined) {
        const { doc, flat } = await this.readAllTabs(client, options.documentId);
        const tab = resolveTab(flat, options.tabId, { allowDefault: true });
        const endIndex = bodyEndIndex(tab.tab.documentTab?.body);

        await client.documents.batchUpdate({
          documentId: options.documentId,
          requestBody: { requests: this.buildReplaceRequests(endIndex, options.content, tab.tabId) },
        });

        const result: DocumentResponse = {
          title: doc.title || 'Untitled',
          documentId: options.documentId,
          documentUrl: this.constructDocumentUrl(options.documentId),
          requestedTab: { tabId: tab.tabId, title: tab.title, path: tab.path },
        };
        return { success: true, data: result };
      }

      // First get the document to find the content range
      const docResponse = await client.documents.get({
        documentId: options.documentId,
      });

      const doc = docResponse.data;
      const endIndex = this.getDocumentEndIndex(doc);

      await client.documents.batchUpdate({
        documentId: options.documentId,
        requestBody: { requests: this.buildReplaceRequests(endIndex, options.content) },
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
      // An expired/revoked grant must keep its reconnect signal — folding it
      // into a plain error string would skip the host's auth_required handoff.
      if (isAuthHandoffError(error)) throw error;
      if (error instanceof DocsInputError) throw error;
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * Find and replace text in every tab, or only in `tabId`'s tab
   * (sub-tabs are separate tabs and are not included).
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

      let target: FlatTab | undefined;
      let preRead: { doc: docs_v1.Schema$Document; flat: FlatTab[] } | undefined;
      if (options.tabId !== undefined) {
        preRead = await this.readTabTree(client, options.documentId);
        target = resolveTab(preRead.flat, options.tabId, { allowDefault: true });
      }

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
                ...(target ? { tabsCriteria: { tabIds: [target.tabId] } } : {}),
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

      // Title + tab tree (no content): reuse the pre-read when tab_id was set;
      // otherwise read it now for the "Searched all <n> tabs" note.
      const tree = preRead ?? (await this.readTabTree(client, options.documentId));

      const data: DocumentResponse = {
        title: tree.doc.title || 'Untitled',
        documentId: options.documentId,
        documentUrl: this.constructDocumentUrl(options.documentId),
        tabCount: tree.flat.length,
        ...(target
          ? { requestedTab: { tabId: target.tabId, title: target.title, path: target.path } }
          : {}),
      };

      return {
        success: true,
        data,
        occurrencesChanged,
      };
    } catch (error) {
      // An expired/revoked grant must keep its reconnect signal — folding it
      // into a plain error string would skip the host's auth_required handoff.
      if (isAuthHandoffError(error)) throw error;
      if (error instanceof DocsInputError) throw error;
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
      // An expired/revoked grant must keep its reconnect signal — folding it
      // into a plain error string would skip the host's auth_required handoff.
      if (isAuthHandoffError(error)) throw error;
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }

  /**
   * List every tab in a document (all nesting levels, tree order).
   * Without word counts this is a tree-only read (no tab content fetched).
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

      const { doc, flat } = options.includeWordCount
        ? await this.readAllTabs(client, options.documentId)
        : await this.readTabTree(client, options.documentId);

      const tabs: TabInfo[] = flat.map((tab) =>
        this.toTabInfo(
          tab,
          options.includeWordCount
            ? countWords(extractBodyText(tab.tab.documentTab?.body))
            : undefined
        )
      );

      const data: TabListResponse = {
        documentId: doc.documentId || options.documentId,
        title: doc.title || 'Untitled',
        tabs,
      };

      return {
        success: true,
        data,
      };
    } catch (error) {
      // An expired/revoked grant must keep its reconnect signal — folding it
      // into a plain error string would skip the host's auth_required handoff.
      if (isAuthHandoffError(error)) throw error;
      if (error instanceof DocsInputError) throw error;
      return {
        success: false,
        error: describeApiError(error),
      };
    }
  }
}
