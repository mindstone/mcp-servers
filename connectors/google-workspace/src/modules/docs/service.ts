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
  AddTabOptions,
  UpdateTabOptions,
  DeleteTabOptions,
  InsertTextOptions,
  InsertTextPosition,
  InsertTextResponse,
  TabDeleteResponse,
  TabRef,
  TabWriteResponse,
} from './types.js';
import { computeMoveApiIndex } from '../../utils/tabPosition.js';
import { DOCS_SCOPES } from './scopes.js';
import { describeApiError, isAuthHandoffError } from '../../utils/apiError.js';
import { wrapUntrustedJsonStrings } from '../../utils/untrusted-content.js';
import {
  ALL_TEXT_KEYS,
  DocsInputError,
  FlatParagraph,
  FlatTab,
  TAB_READ_TEXT_OPTIONS,
  TAB_TREE_FIELDS,
  TRUNCATION_MARKER,
  assertUniqueTitle,
  buildAllTabsText,
  bodyEndIndex,
  countWords,
  descendantsOf,
  extractBodyText,
  findAnchor,
  flatParagraphs,
  flattenTabs,
  nextParagraphInContainer,
  normalizeInsertText,
  paragraphSearchText,
  requireTabs,
  resolveTab,
  siblingsOf,
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

    let textContent = extractBodyText(tab.tab.documentTab?.body, TAB_READ_TEXT_OPTIONS);
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

  /**
   * Initialised, scope-checked Docs client for a write.
   */
  private async getWriteClient(email: string): Promise<docs_v1.Docs> {
    await this.ensureInitialized();
    this.checkInitialized();
    await this.validateScopes(email, [DOCS_SCOPES.FULL]);
    return this.getAuthenticatedClient(email, (auth) => google.docs({ version: 'v1', auth }));
  }

  /**
   * Shared catch for the tab-management and insert methods: auth handoffs and
   * input errors propagate; API failures become `{ success: false }`.
   */
  private toFailure(error: unknown): DocsOperationResult {
    // An expired/revoked grant must keep its reconnect signal — folding it
    // into a plain error string would skip the host's auth_required handoff.
    if (isAuthHandoffError(error)) throw error;
    if (error instanceof DocsInputError) throw error;
    return {
      success: false,
      error: describeApiError(error),
    };
  }

  private toTabRef(tab: FlatTab): TabRef {
    return { tabId: tab.tabId, title: tab.title, path: tab.path };
  }

  private parentRef(flat: FlatTab[], tab: FlatTab): TabRef | null {
    const parent = tab.parentTabId !== null ? flat.find((t) => t.tabId === tab.parentTabId) : undefined;
    return parent ? this.toTabRef(parent) : null;
  }

  /**
   * Add a tab (optionally under a parent, at a 0-based position among its new
   * siblings). Reports the tab as the document shows it after the write.
   */
  async addTab(email: string, options: AddTabOptions): Promise<DocsOperationResult> {
    try {
      const title = requireTabTitle(options.title);
      const client = await this.getWriteClient(email);
      const { flat } = await this.readTabTree(client, options.documentId);

      assertUniqueTitle(flat, title);
      const parent =
        options.parentTabId !== undefined
          ? resolveTab(flat, options.parentTabId, { allowDefault: true })
          : null;
      const siblingCount = siblingsOf(flat, parent?.tabId ?? null).length;
      assertTabPosition(options.position, siblingCount);

      const response = await client.documents.batchUpdate({
        documentId: options.documentId,
        requestBody: {
          requests: [
            {
              addDocumentTab: {
                tabProperties: {
                  title,
                  ...(parent ? { parentTabId: parent.tabId } : {}),
                  // No index → the API's default placement (expected: end).
                  ...(options.position !== undefined ? { index: options.position } : {}),
                },
              },
            },
          ],
        },
      });

      const newTabId = response.data.replies?.[0]?.addDocumentTab?.tabProperties?.tabId;
      if (!newTabId) {
        throw new Error('Docs API did not return the id of the added tab');
      }

      const after = await this.readTabTree(client, options.documentId);
      const created = after.flat.find((tab) => tab.tabId === newTabId);
      if (!created) {
        throw new Error(`Added tab ${newTabId} is missing from the document's tab list`);
      }

      const data: TabWriteResponse = {
        documentId: options.documentId,
        tab: this.toTabInfo(created),
        parent: this.parentRef(after.flat, created),
        changed: true,
        requestedPosition: options.position ?? siblingCount,
        requestedParentTabId: parent?.tabId ?? null,
      };
      return { success: true, data };
    } catch (error) {
      return this.toFailure(error);
    }
  }

  /**
   * Rename and/or move a tab. `position` is the 0-based position the tab should
   * end up at among its destination siblings; the API's before-removal index is
   * computed here. Reports the actual title, parent and position after the write.
   */
  async updateTab(email: string, options: UpdateTabOptions): Promise<DocsOperationResult> {
    try {
      if (
        options.title === undefined &&
        options.parentTabId === undefined &&
        !options.moveToTopLevel &&
        options.position === undefined
      ) {
        throw new DocsInputError('Pass at least one of title, parent_tab_id, move_to_top_level or position.');
      }
      if (options.parentTabId !== undefined && options.moveToTopLevel) {
        throw new DocsInputError('Pass either parent_tab_id or move_to_top_level, not both.');
      }
      const newTitle = options.title !== undefined ? requireTabTitle(options.title) : undefined;

      const client = await this.getWriteClient(email);
      const { flat } = await this.readTabTree(client, options.documentId);

      const current = resolveTab(flat, options.tabId, { allowDefault: false });
      const titleChanged = newTitle !== undefined && newTitle !== current.title;
      if (titleChanged) {
        assertUniqueTitle(flat, newTitle, current.tabId);
      }

      // Destination parent first; "same parent" is decided by identity, so
      // move_to_top_level on a top-level tab (or parent_tab_id equal to the
      // current parent) is a reorder, not a re-parent.
      const destParent: string | null = options.moveToTopLevel
        ? null
        : options.parentTabId !== undefined
          ? resolveTab(flat, options.parentTabId, { allowDefault: false }).tabId
          : current.parentTabId;
      if (
        destParent !== null &&
        (destParent === current.tabId ||
          descendantsOf(flat, current.tabId).some((tab) => tab.tabId === destParent))
      ) {
        throw new DocsInputError('A tab cannot be moved under itself or one of its own sub-tabs.');
      }
      const sameParent = destParent === current.parentTabId;

      const destSiblingCount = siblingsOf(flat, destParent).filter(
        (tab) => tab.tabId !== current.tabId
      ).length;
      assertTabPosition(options.position, destSiblingCount);
      const targetPosition = options.position ?? (sameParent ? current.index : destSiblingCount);
      const positionChanged = !sameParent || targetPosition !== current.index;

      if (!titleChanged && !positionChanged) {
        const data: TabWriteResponse = {
          documentId: options.documentId,
          tab: this.toTabInfo(current),
          parent: this.parentRef(flat, current),
          changed: false,
          requestedPosition: targetPosition,
          requestedParentTabId: destParent,
        };
        return { success: true, data };
      }

      const tabProperties: docs_v1.Schema$TabProperties = { tabId: current.tabId };
      const fields: string[] = [];
      if (titleChanged) {
        tabProperties.title = newTitle;
        fields.push('title');
      }
      if (!sameParent) {
        // Moving to the top level: parentTabId listed in fields with no value.
        if (destParent !== null) {
          tabProperties.parentTabId = destParent;
        }
        fields.push('parentTabId');
      }
      if (positionChanged) {
        tabProperties.index = computeMoveApiIndex({
          sameParent,
          currentIndex: current.index,
          targetPosition,
        });
        fields.push('index');
      }

      await client.documents.batchUpdate({
        documentId: options.documentId,
        requestBody: {
          requests: [
            {
              updateDocumentTabProperties: {
                tabProperties,
                fields: fields.join(','),
              },
            },
          ],
        },
      });

      const after = await this.readTabTree(client, options.documentId);
      const updated = after.flat.find((tab) => tab.tabId === current.tabId);
      if (!updated) {
        throw new Error(`Updated tab ${current.tabId} is missing from the document's tab list`);
      }

      const data: TabWriteResponse = {
        documentId: options.documentId,
        tab: this.toTabInfo(updated),
        parent: this.parentRef(after.flat, updated),
        changed: true,
        requestedPosition: targetPosition,
        requestedParentTabId: destParent,
      };
      return { success: true, data };
    } catch (error) {
      return this.toFailure(error);
    }
  }

  /**
   * Delete a tab and, with it, every sub-tab below it. A tab that has sub-tabs
   * is refused before any write unless the caller passes `deleteSubTabs`.
   */
  async deleteTab(email: string, options: DeleteTabOptions): Promise<DocsOperationResult> {
    try {
      const client = await this.getWriteClient(email);
      const { flat } = await this.readTabTree(client, options.documentId);

      const target = resolveTab(flat, options.tabId, { allowDefault: false });
      const descendants = descendantsOf(flat, target.tabId);
      if (descendants.length > 0 && options.deleteSubTabs !== true) {
        const count = descendants.length;
        throw new DocsInputError(
          `Tab "${target.tabId}" has ${count} sub-tab${count !== 1 ? 's' : ''}, which would be deleted with it. Nothing was deleted. ` +
            'Check with list_workspace_document_tabs that this is the tab you mean, then pass delete_sub_tabs: true to delete it and all its sub-tabs.'
        );
      }

      await client.documents.batchUpdate({
        documentId: options.documentId,
        requestBody: {
          requests: [{ deleteTab: { tabId: target.tabId } }],
        },
      });

      const after = await this.readTabTree(client, options.documentId);
      if (after.flat.some((tab) => tab.tabId === target.tabId)) {
        throw new Error(`Docs API accepted the delete, but tab ${target.tabId} is still in the document`);
      }

      const data: TabDeleteResponse = {
        documentId: options.documentId,
        deleted: this.toTabRef(target),
        descendants: descendants.map((tab) => this.toTabRef(tab)),
      };
      return { success: true, data };
    } catch (error) {
      return this.toFailure(error);
    }
  }

  /**
   * Insert plain text into one tab next to a unique anchor: right after it,
   * right before it, or at the start of the paragraph that follows it (in the
   * same container). The inserted text takes the paragraph formatting of where
   * it lands (heading, bullet) but its character style is cleared. The text is
   * first normalised to what Docs stores, so the style-clear range never
   * reaches past it into existing text.
   */
  async insertText(email: string, options: InsertTextOptions): Promise<DocsOperationResult> {
    try {
      if (!INSERT_POSITIONS.includes(options.position)) {
        throw new DocsInputError('position must be "after", "before" or "next_paragraph_start".');
      }
      if (options.text.length === 0) {
        throw new DocsInputError('text must not be empty.');
      }
      const { text, removedChars } = normalizeInsertText(options.text);
      if (text.length === 0) {
        throw new DocsInputError(
          'text has nothing Google Docs can store: it holds only control or private-use characters, which Docs removes.'
        );
      }
      // Filling a slot is the usual reason for next_paragraph_start, so the guard is on there by default.
      const expectEmptyParagraph =
        options.expectEmptyParagraph ?? options.position === 'next_paragraph_start';

      const client = await this.getWriteClient(email);
      const { flat } = await this.readAllTabs(client, options.documentId);

      // No tab_id = the first tab, like append.
      const tab = resolveTab(flat, options.tabId ?? 'default', { allowDefault: true });
      const body = tab.tab.documentTab?.body;
      const paragraphs = flatParagraphs(body);
      const matches = findAnchor(paragraphs, options.anchorText, options.matchCase);

      if (matches.length === 0) {
        throw new DocsInputError(
          `Anchor text not found in tab "${tab.tabId}". It must be plain text inside one paragraph (smart chips, people and dates can't be part of it); read the tab with tab_id to copy it exactly, leaving out the "• " and "[H1]"-style markers, which are not document text.`
        );
      }
      if (matches.length > 1) {
        throw new DocsInputError(
          `Anchor text found ${matches.length} times in this tab; use a longer anchor that appears once.`
        );
      }

      const match = matches[0];
      const anchorParagraph = paragraphs[match.paragraphIdx];
      let index: number;
      let target: FlatParagraph;
      switch (options.position) {
        case 'after':
          index = anchorParagraph.startIndex + match.offset + options.anchorText.length;
          target = anchorParagraph;
          break;
        case 'before':
          index = anchorParagraph.startIndex + match.offset;
          target = anchorParagraph;
          break;
        case 'next_paragraph_start':
          target = nextParagraphInContainer(body, paragraphs, match.paragraphIdx);
          index = target.startIndex;
          break;
      }

      const targetText = paragraphSearchText(target.paragraph);
      const wasEmpty = targetText === '' || targetText === '\n';
      const bulleted = target.paragraph.bullet != null;
      const namedStyleType = target.paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
      if (expectEmptyParagraph && !wasEmpty) {
        const visibleChars = targetText.endsWith('\n') ? targetText.length - 1 : targetText.length;
        const guardSource = options.expectEmptyParagraph === true
          ? 'expect_empty_paragraph is set'
          : 'expect_empty_paragraph is on (the default for "next_paragraph_start")';
        throw new DocsInputError(
          `${guardSource}, but the paragraph the text would land in is not empty: it holds ${visibleChars} character(s), ${bulleted ? 'bulleted' : 'not bulleted'}, style ${namedStyleType}. Nothing was inserted. ` +
            'Anchor on the line directly above the empty slot (if an instruction line sits between the heading and the slot, anchor on that line), ' +
            'or pass expect_empty_paragraph: false to insert at the start of this paragraph anyway.'
        );
      }

      await client.documents.batchUpdate({
        documentId: options.documentId,
        requestBody: {
          requests: [
            { insertText: { location: { index, tabId: tab.tabId }, text } },
            {
              // Plain text: keep the paragraph's formatting, drop neighbouring run styles.
              updateTextStyle: {
                range: { startIndex: index, endIndex: index + text.length, tabId: tab.tabId },
                textStyle: {},
                fields: ALL_TEXT_KEYS,
              },
            },
          ],
        },
      });

      const data: InsertTextResponse = {
        documentId: options.documentId,
        tab: this.toTabRef(tab),
        position: options.position,
        index,
        insertedChars: text.length,
        removedChars,
        newParagraphs: text.split('\n').length - 1,
        targetParagraph: { wasEmpty, namedStyleType, bulleted },
      };
      return { success: true, data };
    } catch (error) {
      return this.toFailure(error);
    }
  }
}

const INSERT_POSITIONS: readonly InsertTextPosition[] = ['after', 'before', 'next_paragraph_start'];

function requireTabTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new DocsInputError('title must not be empty.');
  }
  return trimmed;
}

function assertTabPosition(position: number | undefined, max: number): void {
  if (position === undefined) return;
  if (!Number.isInteger(position) || position < 0 || position > max) {
    throw new DocsInputError(
      `position must be a whole number from 0 to ${max} (0 = first; the numbers in list outputs start at 1).`
    );
  }
}
