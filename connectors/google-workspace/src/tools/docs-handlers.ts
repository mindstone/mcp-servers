import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getAccountManager, resolveEmail } from '../modules/accounts/index.js';
import { getDocsService } from '../modules/docs/index.js';
import { extractDocumentIdFromUrl } from '../modules/docs/formatters.js';
import {
  ReadDocumentOptions,
  CreateDocumentOptions,
  AppendDocumentOptions,
  ReplaceDocumentOptions,
  FindReplaceOptions,
  ListTabsOptions,
  BatchUpdateDocumentOptions,
  DocumentResponse,
  DocsBatchUpdateResponse,
  TabListResponse,
  TabWriteResponse,
  TabDeleteResponse,
  InsertTextPosition,
  InsertTextResponse,
} from '../modules/docs/types.js';
import { McpToolResponse } from './types.js';
import {
  readAliasedBoolean,
  readAliasedNumber,
  readAliasedString,
  readAliasedValue
} from './arg-aliases.js';
import { wrapUntrustedContent, wrapUntrustedJsonStrings } from '../utils/untrusted-content.js';

// Handler argument types
interface ReadDocumentArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  max_chars?: number;
  maxChars?: number;
  return_json?: boolean;
  returnJson?: boolean;
  tab_id?: string;
  tabId?: string;
  all_tabs?: boolean;
  allTabs?: boolean;
}

interface CreateDocumentArgs {
  email?: string;
  title: string;
  content?: string;
}

interface AppendDocumentArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  text: string;
  tab_id?: string;
  tabId?: string;
}

interface ReplaceDocumentArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  content: string;
  tab_id?: string;
  tabId?: string;
}

interface FindReplaceArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  find_text?: string;
  findText?: string;
  replace_text?: string;
  replaceText?: string;
  match_case?: boolean;
  matchCase?: boolean;
  tab_id?: string;
  tabId?: string;
}

interface ExtractIdArgs {
  input: string;
}

interface ListTabsArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  include_word_count?: boolean;
  includeWordCount?: boolean;
  return_json?: boolean;
  returnJson?: boolean;
}

interface BatchUpdateDocumentArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  requests: object[];
  write_control?: {
    requiredRevisionId?: string;
  };
  writeControl?: {
    requiredRevisionId?: string;
  };
  return_json?: boolean;
  returnJson?: boolean;
}

interface AddDocumentTabArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  title: string;
  parent_tab_id?: string;
  parentTabId?: string;
  position?: number;
}

interface UpdateDocumentTabArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  tab_id?: string;
  tabId?: string;
  title?: string;
  parent_tab_id?: string;
  parentTabId?: string;
  move_to_top_level?: boolean;
  moveToTopLevel?: boolean;
  position?: number;
}

interface DeleteDocumentTabArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  tab_id?: string;
  tabId?: string;
  delete_sub_tabs?: boolean;
  deleteSubTabs?: boolean;
}

interface InsertDocumentTextArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  tab_id?: string;
  tabId?: string;
  anchor_text?: string;
  anchorText?: string;
  position?: string;
  text: string;
  match_case?: boolean;
  matchCase?: boolean;
  expect_empty_paragraph?: boolean;
  expectEmptyParagraph?: boolean;
}

/**
 * Format DocumentResponse as human-readable text
 */
export function formatDocumentResponseAsText(doc: DocumentResponse): string {
  const lines: string[] = [];
  lines.push(`Document: ${doc.title}`);
  lines.push(`URL: ${doc.documentUrl}`);
  lines.push(`ID: ${doc.documentId}`);

  if (doc.requestedTab) {
    const subTabs = doc.requestedTab.childCount ?? 0;
    const subTabNote = subTabs > 0
      ? ` (${subTabs} sub-tab${subTabs !== 1 ? 's' : ''}, not included — read them by tab_id)`
      : '';
    lines.push(`Tab: ${doc.requestedTab.path} [tabId: ${doc.requestedTab.tabId}]${subTabNote}`);
  } else if (doc.shownTab && doc.tabCount !== undefined && doc.tabCount > 1) {
    lines.push(
      `Tabs: ${doc.tabCount} — showing the first tab "${doc.shownTab.title}" [tabId: ${doc.shownTab.tabId}]. ` +
        'Pass tab_id (or all_tabs: true) to read others; list_workspace_document_tabs shows the tree.'
    );
  }

  if (doc.truncated) {
    lines.push('Status: TRUNCATED (content exceeded limit)');
  }
  
  if (doc.content !== undefined) {
    lines.push('---');
    lines.push(doc.content);
  }
  
  return wrapUntrustedContent(lines.join('\n'), `google-workspace:docs:document/${doc.documentId}`);
}

/**
 * Format a document's tab tree as human-readable text: one line per tab,
 * indented by nesting level and numbered by path (1., 1.1., 1.1.1.).
 */
export function formatTabsAsText(result: TabListResponse): string {
  const tabs = result.tabs;
  if (!tabs || tabs.length === 0) {
    return 'No tabs found.';
  }

  const topLevel = tabs.filter((tab) => tab.nestingLevel === 0).length;
  const lines: string[] = [];
  lines.push(`Tabs: ${tabs.length} (${topLevel} top-level)\n`);

  const numbers = new Map<string, string>();
  for (const tab of tabs) {
    const parentNumber = tab.parentTabId !== null ? numbers.get(tab.parentTabId) ?? '' : '';
    const number = `${parentNumber}${tab.index + 1}.`;
    numbers.set(tab.tabId, number);

    let line = `${'   '.repeat(tab.nestingLevel)}${number} ${tab.title} [tabId: ${tab.tabId}]`;
    if (tab.childCount > 0) {
      line += ` (${tab.childCount} sub-tab${tab.childCount !== 1 ? 's' : ''})`;
    }
    if (tab.wordCount !== undefined) {
      line += ` (${tab.wordCount} words)`;
    }
    lines.push(line);
  }

  return wrapUntrustedContent(lines.join('\n'), `google-workspace:docs:tabs/${result.documentId}`);
}

/**
 * `Document: <title>` line for edit results, with the Google-authored title enveloped.
 */
function formatEnvelopedDocumentLine(doc: DocumentResponse, documentId: string): string {
  return `Document: ${wrapUntrustedContent(doc.title ?? '', `google-workspace:docs:document/${documentId}`)}`;
}

/**
 * ` (tab <id>)` suffix for the first line of a tab-scoped edit result (id only).
 */
function tabSuffix(doc: DocumentResponse): string {
  return doc.requestedTab ? ` (tab ${doc.requestedTab.tabId})` : '';
}

/**
 * Read a Google Docs document
 */
export async function handleReadDocument(args: ReadDocumentArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const documentId = readAliasedString(rawArgs, 'document_id', 'documentId');
  const maxChars = readAliasedNumber(rawArgs, 'max_chars', 'maxChars');
  const returnJson = readAliasedBoolean(rawArgs, 'return_json', 'returnJson');
  const tabId = readAliasedString(rawArgs, 'tab_id', 'tabId');
  const allTabs = readAliasedBoolean(rawArgs, 'all_tabs', 'allTabs');

  if (tabId !== undefined && allTabs === true) {
    throw new McpError(ErrorCode.InvalidParams, 'Pass either tab_id or all_tabs, not both.');
  }
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const docsService = getDocsService();
    
    const options: ReadDocumentOptions = {
      maxChars,
      returnJson,
      ...(tabId !== undefined ? { tabId } : {}),
      ...(allTabs === true ? { allTabs } : {}),
    };
    
    const result = await docsService.getDocument(email, documentId as string, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to read document');
    }
    
    if (returnJson) {
      return wrapUntrustedJsonStrings(result.data, `google-workspace:docs:document/${documentId}`);
    }
    
    // Format as human-readable text
    const docResponse = result.data as DocumentResponse;
    return formatDocumentResponseAsText(docResponse);
  });
}

/**
 * Create a new Google Docs document
 */
export async function handleCreateDocument(args: CreateDocumentArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const docsService = getDocsService();
    
    const options: CreateDocumentOptions = {
      title: args.title,
      content: args.content,
    };
    
    const result = await docsService.createDocument(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to create document');
    }
    
    const docResponse = result.data as DocumentResponse;
    return `Document created successfully!\n\nTitle: ${docResponse.title}\nURL: ${docResponse.documentUrl}\nID: ${docResponse.documentId}`;
  });
}

/**
 * Append text to a Google Docs document
 */
export async function handleAppendDocument(args: AppendDocumentArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const documentId = readAliasedString(rawArgs, 'document_id', 'documentId');
  const tabId = readAliasedString(rawArgs, 'tab_id', 'tabId');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const docsService = getDocsService();
    
    const options: AppendDocumentOptions = {
      documentId: documentId as string,
      text: args.text,
      ...(tabId !== undefined ? { tabId } : {}),
    };
    
    const result = await docsService.appendToDocument(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to append to document');
    }
    
    const docResponse = result.data as DocumentResponse;
    return `Text appended successfully!${tabSuffix(docResponse)}\n\n${formatEnvelopedDocumentLine(docResponse, documentId as string)}\nURL: ${docResponse.documentUrl}`;
  });
}

/**
 * Replace entire content of a Google Docs document
 */
export async function handleReplaceDocument(args: ReplaceDocumentArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const documentId = readAliasedString(rawArgs, 'document_id', 'documentId');
  const tabId = readAliasedString(rawArgs, 'tab_id', 'tabId');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const docsService = getDocsService();
    
    const options: ReplaceDocumentOptions = {
      documentId: documentId as string,
      content: args.content,
      ...(tabId !== undefined ? { tabId } : {}),
    };
    
    const result = await docsService.replaceDocument(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to replace document content');
    }
    
    const docResponse = result.data as DocumentResponse;
    return `Document content replaced successfully!${tabSuffix(docResponse)}\n\n${formatEnvelopedDocumentLine(docResponse, documentId as string)}\nURL: ${docResponse.documentUrl}`;
  });
}

/**
 * Find and replace text in a Google Docs document
 */
export async function handleFindAndReplace(args: FindReplaceArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const documentId = readAliasedString(rawArgs, 'document_id', 'documentId');
  const findText = readAliasedString(rawArgs, 'find_text', 'findText');
  const replaceText = readAliasedString(rawArgs, 'replace_text', 'replaceText');
  const matchCase = readAliasedBoolean(rawArgs, 'match_case', 'matchCase');
  const tabId = readAliasedString(rawArgs, 'tab_id', 'tabId');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const docsService = getDocsService();
    
    const options: FindReplaceOptions = {
      documentId: documentId as string,
      findText: findText as string,
      replaceText: replaceText as string,
      matchCase,
      ...(tabId !== undefined ? { tabId } : {}),
    };
    
    const result = await docsService.findAndReplace(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to find and replace');
    }
    
    const occurrences = result.occurrencesChanged ?? 0;
    const docResponse = result.data as DocumentResponse;
    const documentLine = formatEnvelopedDocumentLine(docResponse, documentId as string);
    // Without tab_id the replace covers every tab; say so on multi-tab documents.
    const scopeNote = tabId === undefined && (docResponse.tabCount ?? 0) > 1
      ? `\nSearched all ${docResponse.tabCount} tabs. Pass tab_id to limit a replace to one tab.`
      : '';
    
    if (occurrences === 0) {
      // A tab-scoped miss names the tab searched, not the whole document.
      const searched = docResponse.requestedTab ? `tab ${docResponse.requestedTab.tabId}` : 'the document';
      return `No occurrences of "${findText}" found in ${searched}.\n\n${documentLine}\nURL: ${docResponse.documentUrl}${scopeNote}`;
    }
    
    return `Find and replace completed!${tabSuffix(docResponse)}\n\nReplaced ${occurrences} occurrence${occurrences !== 1 ? 's' : ''} of "${findText}" with "${replaceText}"\n\n${documentLine}\nURL: ${docResponse.documentUrl}${scopeNote}`;
  });
}

/**
 * Extract document ID from URL or validate existing ID
 */
export async function handleExtractDocumentId(args: ExtractIdArgs): Promise<McpToolResponse | string | object> {
  const documentId = extractDocumentIdFromUrl(args.input);
  
  if (!documentId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Could not extract document ID from input: "${args.input}". Expected a Google Docs URL (e.g., https://docs.google.com/document/d/{id}/edit) or a valid document ID.`
    );
  }
  
  return `Document ID: ${documentId}`;
}

/**
 * List tabs in a Google Docs document
 */
export async function handleListDocumentTabs(args: ListTabsArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const documentId = readAliasedString(rawArgs, 'document_id', 'documentId');
  const includeWordCount = readAliasedBoolean(rawArgs, 'include_word_count', 'includeWordCount');
  const returnJson = readAliasedBoolean(rawArgs, 'return_json', 'returnJson');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const docsService = getDocsService();
    
    const options: ListTabsOptions = {
      documentId: documentId as string,
      includeWordCount,
    };
    
    const result = await docsService.listTabs(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to list document tabs');
    }
    
    const tabList = result.data as TabListResponse;
    if (returnJson) {
      return wrapUntrustedJsonStrings(
        {
          documentId: tabList.documentId,
          title: tabList.title,
          tabCount: tabList.tabs.length,
          tabs: tabList.tabs,
        },
        `google-workspace:docs:tabs/${tabList.documentId}`
      );
    }
    return formatTabsAsText(tabList);
  });
}

/**
 * Batch update a Google Docs document with multiple operations
 */
export async function handleBatchUpdateDocument(args: BatchUpdateDocumentArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const documentIdInput = readAliasedString(rawArgs, 'document_id', 'documentId');
  const writeControl = readAliasedValue<{ requiredRevisionId?: string }>(rawArgs, 'write_control', 'writeControl');
  const returnJson = readAliasedBoolean(rawArgs, 'return_json', 'returnJson');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  // Extract document ID from URL or use raw ID
  const documentId = extractDocumentIdFromUrl(documentIdInput as string);
  if (!documentId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid document ID or URL: "${documentIdInput}". Provide a valid Google Docs URL or document ID.`
    );
  }
  
  return await accountManager.withTokenRenewal(email, async () => {
    const docsService = getDocsService();
    
    const options: BatchUpdateDocumentOptions = {
      requests: args.requests as BatchUpdateDocumentOptions['requests'],
      writeControl,
      returnJson,
    };
    
    const result = await docsService.batchUpdate(email, documentId, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to update document');
    }
    
    if (returnJson) {
      return wrapUntrustedJsonStrings(result.data, `google-workspace:docs:batch-update/${documentId}`);
    }
    
    // Format as human-readable text
    const response = result.data as DocsBatchUpdateResponse;
    const repliesCount = response.replies?.length ?? 0;
    const lines: string[] = [
      'Document updated successfully!',
      '',
      `Document ID: ${documentId}`,
      `URL: https://docs.google.com/document/d/${documentId}/edit`,
      `Changes applied: ${repliesCount} request(s)`,
    ];
    
    // Include revision ID if present in the response's write control
    if (response.writeControl?.requiredRevisionId) {
      lines.push(`Revision ID: ${response.writeControl.requiredRevisionId}`);
    }
    
    return lines.join('\n');
  });
}

/**
 * `under "<parent path>"` / `at the top level` for a tab's placement.
 */
function placementPhrase(parent: TabWriteResponse['parent']): string {
  return parent ? `under "${parent.path}"` : 'at the top level';
}

/**
 * A WARNING line naming any difference between where the caller asked the tab
 * to go and where the document reports it after the write (no silent mismatch).
 */
function placementMismatch(data: TabWriteResponse): string | undefined {
  const notes: string[] = [];
  const actualParent = data.parent?.tabId ?? null;
  if (actualParent !== data.requestedParentTabId) {
    const wanted = data.requestedParentTabId !== null
      ? `under tab ${data.requestedParentTabId}`
      : 'at the top level';
    notes.push(`it was meant to go ${wanted}, but the document shows it ${placementPhrase(data.parent)}`);
  }
  if (data.tab.index !== data.requestedPosition) {
    notes.push(`the requested position was ${data.requestedPosition}, but the document reports position ${data.tab.index}`);
  }
  return notes.length > 0 ? `WARNING: ${notes.join('; ')}. Check the tab list before going on.` : undefined;
}

/**
 * Result of add_workspace_document_tab (titles enveloped).
 */
export function formatTabAddedAsText(data: TabWriteResponse): string {
  const where = data.parent
    ? `under "${data.parent.path}" at position ${data.tab.index}`
    : `at the top level, position ${data.tab.index}`;
  const lines = [`Tab added: "${data.tab.title}" [tabId: ${data.tab.tabId}] ${where} (0 = first).`];
  const mismatch = placementMismatch(data);
  if (mismatch) lines.push(mismatch);
  return wrapUntrustedContent(lines.join('\n'), `google-workspace:docs:tabs/${data.documentId}`);
}

/**
 * Result of update_workspace_document_tab (titles enveloped).
 */
export function formatTabUpdatedAsText(data: TabWriteResponse): string {
  if (!data.changed) {
    return wrapUntrustedContent(
      `No change: tab "${data.tab.path}" [tabId: ${data.tab.tabId}] already has that title, parent and position.`,
      `google-workspace:docs:tabs/${data.documentId}`
    );
  }
  const lines = [
    `Tab updated: "${data.tab.title}" [tabId: ${data.tab.tabId}] — now ${placementPhrase(data.parent)}, position ${data.tab.index} (0 = first).`,
  ];
  const mismatch = placementMismatch(data);
  if (mismatch) lines.push(mismatch);
  return wrapUntrustedContent(lines.join('\n'), `google-workspace:docs:tabs/${data.documentId}`);
}

/**
 * Result of delete_workspace_document_tab: the tab and every sub-tab deleted with it.
 */
export function formatTabDeletedAsText(data: TabDeleteResponse): string {
  const head = `Deleted tab "${data.deleted.path}" [tabId: ${data.deleted.tabId}]`;
  const count = data.descendants.length;
  const text = count === 0
    ? `${head}. It had no sub-tabs.`
    : [
        `${head} and ${count} sub-tab${count !== 1 ? 's' : ''}:`,
        ...data.descendants.map((tab) => `- "${tab.path}" [tabId: ${tab.tabId}]`),
      ].join('\n');
  return wrapUntrustedContent(text, `google-workspace:docs:tabs/${data.documentId}`);
}

const INSERT_POSITION_PHRASES: Record<InsertTextPosition, string> = {
  after: 'after the anchor',
  before: 'before the anchor',
  next_paragraph_start: 'at the start of the paragraph after the anchor',
};

/**
 * Result of insert_workspace_document_text (tab title enveloped).
 */
export function formatInsertTextAsText(data: InsertTextResponse): string {
  const target = data.targetParagraph;
  const text =
    `Inserted ${data.insertedChars} characters (${data.newParagraphs} new paragraph${data.newParagraphs !== 1 ? 's' : ''}) ` +
    `${INSERT_POSITION_PHRASES[data.position]} in tab "${data.tab.path}" [tabId: ${data.tab.tabId}]. ` +
    `The paragraph there was ${target.wasEmpty ? 'empty' : 'not empty'}, ${target.bulleted ? 'bulleted' : 'not bulleted'}, style ${target.namedStyleType}.` +
    (data.removedChars > 0
      ? ` ${data.removedChars} control or private-use character${data.removedChars !== 1 ? 's' : ''} that Google Docs can't store ${data.removedChars !== 1 ? 'were' : 'was'} left out.`
      : '');
  return wrapUntrustedContent(text, `google-workspace:docs:document/${data.documentId}`);
}

/**
 * `position` as a number, or undefined (the type guard has already checked it).
 */
function readPosition(rawArgs: Record<string, unknown>): number | undefined {
  return typeof rawArgs.position === 'number' ? rawArgs.position : undefined;
}

/**
 * Add a tab to a Google Docs document
 */
export async function handleAddDocumentTab(args: AddDocumentTabArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const documentId = readAliasedString(rawArgs, 'document_id', 'documentId');
  const parentTabId = readAliasedString(rawArgs, 'parent_tab_id', 'parentTabId');
  const position = readPosition(rawArgs);

  const email = await resolveEmail(args);

  return await accountManager.withTokenRenewal(email, async () => {
    const result = await getDocsService().addTab(email, {
      documentId: documentId as string,
      title: args.title,
      ...(parentTabId !== undefined ? { parentTabId } : {}),
      ...(position !== undefined ? { position } : {}),
    });

    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to add document tab');
    }
    return formatTabAddedAsText(result.data as TabWriteResponse);
  });
}

/**
 * Rename and/or move a tab in a Google Docs document
 */
export async function handleUpdateDocumentTab(args: UpdateDocumentTabArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const documentId = readAliasedString(rawArgs, 'document_id', 'documentId');
  const tabId = readAliasedString(rawArgs, 'tab_id', 'tabId');
  const parentTabId = readAliasedString(rawArgs, 'parent_tab_id', 'parentTabId');
  const moveToTopLevel = readAliasedBoolean(rawArgs, 'move_to_top_level', 'moveToTopLevel');
  const position = readPosition(rawArgs);

  const email = await resolveEmail(args);

  return await accountManager.withTokenRenewal(email, async () => {
    const result = await getDocsService().updateTab(email, {
      documentId: documentId as string,
      tabId: tabId as string,
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(parentTabId !== undefined ? { parentTabId } : {}),
      ...(moveToTopLevel === true ? { moveToTopLevel } : {}),
      ...(position !== undefined ? { position } : {}),
    });

    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to update document tab');
    }
    return formatTabUpdatedAsText(result.data as TabWriteResponse);
  });
}

/**
 * Delete a tab (and all its sub-tabs) from a Google Docs document
 */
export async function handleDeleteDocumentTab(args: DeleteDocumentTabArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const documentId = readAliasedString(rawArgs, 'document_id', 'documentId');
  const tabId = readAliasedString(rawArgs, 'tab_id', 'tabId');
  const deleteSubTabs = readAliasedBoolean(rawArgs, 'delete_sub_tabs', 'deleteSubTabs');

  const email = await resolveEmail(args);

  return await accountManager.withTokenRenewal(email, async () => {
    const result = await getDocsService().deleteTab(email, {
      documentId: documentId as string,
      tabId: tabId as string,
      ...(deleteSubTabs === true ? { deleteSubTabs } : {}),
    });

    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to delete document tab');
    }
    return formatTabDeletedAsText(result.data as TabDeleteResponse);
  });
}

/**
 * Insert plain text into one tab next to a unique anchor
 */
export async function handleInsertDocumentText(args: InsertDocumentTextArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const documentId = readAliasedString(rawArgs, 'document_id', 'documentId');
  const tabId = readAliasedString(rawArgs, 'tab_id', 'tabId');
  const anchorText = readAliasedString(rawArgs, 'anchor_text', 'anchorText');
  const matchCase = readAliasedBoolean(rawArgs, 'match_case', 'matchCase');
  const expectEmptyParagraph = readAliasedBoolean(rawArgs, 'expect_empty_paragraph', 'expectEmptyParagraph');
  const position = (typeof rawArgs.position === 'string' ? rawArgs.position : 'after') as InsertTextPosition;

  const email = await resolveEmail(args);

  return await accountManager.withTokenRenewal(email, async () => {
    const result = await getDocsService().insertText(email, {
      documentId: documentId as string,
      ...(tabId !== undefined ? { tabId } : {}),
      anchorText: anchorText as string,
      position,
      text: args.text,
      matchCase: matchCase ?? true,
      // Unset → the service's default (on for next_paragraph_start); an explicit false is kept.
      ...(expectEmptyParagraph !== undefined ? { expectEmptyParagraph } : {}),
    });

    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to insert text');
    }
    return formatInsertTextAsText(result.data as InsertTextResponse);
  });
}
