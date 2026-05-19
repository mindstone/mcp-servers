import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getAccountManager } from '../modules/accounts/index.js';
import { getDocsService } from '../modules/docs/index.js';
import { extractDocumentIdFromUrl } from '../modules/docs/formatters.js';
import { resolveEmail } from '../utils/account.js';
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
  TabInfo,
} from '../modules/docs/types.js';
import { McpToolResponse } from './types.js';
import {
  readAliasedBoolean,
  readAliasedNumber,
  readAliasedString,
  readAliasedValue
} from './arg-aliases.js';

// Handler argument types
interface ReadDocumentArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  max_chars?: number;
  maxChars?: number;
  return_json?: boolean;
  returnJson?: boolean;
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
}

interface ReplaceDocumentArgs {
  email?: string;
  document_id?: string;
  documentId?: string;
  content: string;
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
function formatDocumentResponseAsText(doc: DocumentResponse): string {
  const lines: string[] = [];
  lines.push(`Document: ${doc.title}`);
  lines.push(`URL: ${doc.documentUrl}`);
  lines.push(`ID: ${doc.documentId}`);
  
  if (doc.truncated) {
    lines.push('Status: TRUNCATED (content exceeded limit)');
  }
  
  if (doc.content !== undefined) {
    lines.push('---');
    lines.push(doc.content);
  }
  
  return lines.join('\n');
}

/**
 * Format TabInfo array as human-readable text
 */
function formatTabsAsText(tabs: TabInfo[]): string {
  if (!tabs || tabs.length === 0) {
    return 'No tabs found.';
  }

  const lines: string[] = [];
  lines.push(`Tabs: ${tabs.length} tab${tabs.length !== 1 ? 's' : ''}\n`);

  for (const tab of tabs) {
    let line = `${tab.index + 1}. ${tab.title}`;
    if (tab.wordCount !== undefined) {
      line += ` (${tab.wordCount} words)`;
    }
    line += ` [tabId: ${tab.tabId}]`;
    lines.push(line);
  }

  return lines.join('\n');
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
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const docsService = getDocsService();
    
    const options: ReadDocumentOptions = {
      maxChars,
      returnJson,
    };
    
    const result = await docsService.getDocument(email, documentId as string, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to read document');
    }
    
    if (returnJson) {
      return result.data;
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
  const documentId = readAliasedString(args as unknown as Record<string, unknown>, 'document_id', 'documentId');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const docsService = getDocsService();
    
    const options: AppendDocumentOptions = {
      documentId: documentId as string,
      text: args.text,
    };
    
    const result = await docsService.appendToDocument(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to append to document');
    }
    
    const docResponse = result.data as DocumentResponse;
    return `Text appended successfully!\n\nDocument: ${docResponse.title}\nURL: ${docResponse.documentUrl}`;
  });
}

/**
 * Replace entire content of a Google Docs document
 */
export async function handleReplaceDocument(args: ReplaceDocumentArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const documentId = readAliasedString(args as unknown as Record<string, unknown>, 'document_id', 'documentId');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const docsService = getDocsService();
    
    const options: ReplaceDocumentOptions = {
      documentId: documentId as string,
      content: args.content,
    };
    
    const result = await docsService.replaceDocument(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to replace document content');
    }
    
    const docResponse = result.data as DocumentResponse;
    return `Document content replaced successfully!\n\nDocument: ${docResponse.title}\nURL: ${docResponse.documentUrl}`;
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
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const docsService = getDocsService();
    
    const options: FindReplaceOptions = {
      documentId: documentId as string,
      findText: findText as string,
      replaceText: replaceText as string,
      matchCase,
    };
    
    const result = await docsService.findAndReplace(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(ErrorCode.InternalError, result.error || 'Failed to find and replace');
    }
    
    const occurrences = result.occurrencesChanged ?? 0;
    const docResponse = result.data as DocumentResponse;
    
    if (occurrences === 0) {
      return `No occurrences of "${findText}" found in the document.\n\nDocument: ${docResponse.title}\nURL: ${docResponse.documentUrl}`;
    }
    
    return `Find and replace completed!\n\nReplaced ${occurrences} occurrence${occurrences !== 1 ? 's' : ''} of "${findText}" with "${replaceText}"\n\nDocument: ${docResponse.title}\nURL: ${docResponse.documentUrl}`;
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
    
    const tabs = result.data as TabInfo[];
    return formatTabsAsText(tabs);
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
      return result.data;
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
