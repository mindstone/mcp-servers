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

/**
 * Format DocumentResponse as human-readable text
 */
export function formatDocumentResponseAsText(doc: DocumentResponse): string {
  const lines: string[] = [];
  lines.push(`Document: ${doc.title}`);
  lines.push(`URL: ${doc.documentUrl}`);
  lines.push(`ID: ${doc.documentId}`);

  if (doc.requestedTab) {
    lines.push(`Tab: ${doc.requestedTab.path} [tabId: ${doc.requestedTab.tabId}]`);
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
      return `No occurrences of "${findText}" found in the document.${tabSuffix(docResponse)}\n\n${documentLine}\nURL: ${docResponse.documentUrl}${scopeNote}`;
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
