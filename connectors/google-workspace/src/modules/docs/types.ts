import { docs_v1 } from 'googleapis';

// Re-export Google API types for convenience
export type DocsDocument = docs_v1.Schema$Document;
export type DocsRequest = docs_v1.Schema$Request;
export type DocsBatchUpdateResponse = docs_v1.Schema$BatchUpdateDocumentResponse;
export type DocsBody = docs_v1.Schema$Body;
export type DocsStructuralElement = docs_v1.Schema$StructuralElement;
export type DocsParagraph = docs_v1.Schema$Paragraph;
export type DocsTable = docs_v1.Schema$Table;
export type DocsParagraphElement = docs_v1.Schema$ParagraphElement;
export type DocsTextRun = docs_v1.Schema$TextRun;
export type DocsWriteControl = docs_v1.Schema$WriteControl;

// Note: Tabs API (Schema$Tab) not available in googleapis@129.
// Tab support will be deferred to a future version upgrade.
// Tools accepting tabId will ignore it and operate on the main document body.

export interface BatchUpdateDocumentOptions {
  requests: DocsRequest[];
  writeControl?: DocsWriteControl;
  returnJson?: boolean; // Default: false (human-readable summary)
}

export interface ReadDocumentOptions {
  tabId?: string; // Ignored until googleapis upgrade supports tabs
  maxChars?: number;
  includeMetadata?: boolean;
  returnJson?: boolean; // Default: false (human-readable text)
}

export interface CreateDocumentOptions {
  title: string;
  content?: string;
}

export interface AppendDocumentOptions {
  documentId: string;
  text: string;
  tabId?: string;
}

export interface ReplaceDocumentOptions {
  documentId: string;
  content: string;
  tabId?: string;
}

export interface FindReplaceOptions {
  documentId: string;
  findText: string;
  replaceText: string;
  matchCase?: boolean;
  tabId?: string;
}

export interface TabInfo {
  tabId: string;
  title: string;
  index: number;
  wordCount?: number;
}

export interface DocumentResponse {
  title: string;
  documentId: string;
  documentUrl: string;
  content?: string;
  truncated?: boolean;
  tabCount?: number;
  tabs?: TabInfo[];
  revisionId?: string;
}

export interface DocsOperationResult {
  success: boolean;
  data?: DocumentResponse | DocsDocument | TabInfo[] | DocsBatchUpdateResponse;
  error?: string;
  occurrencesChanged?: number;
}

export interface ListTabsOptions {
  documentId: string;
  includeWordCount?: boolean;
}

// Note: Since Tabs API is not available in googleapis@129,
// list_workspace_document_tabs will return a placeholder until
// the library is upgraded. The types are defined here for future use.

export interface ExtractIdResult {
  success: boolean;
  documentId?: string;
  error?: string;
}
