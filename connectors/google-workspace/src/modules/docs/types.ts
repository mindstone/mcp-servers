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

export interface BatchUpdateDocumentOptions {
  requests: DocsRequest[];
  writeControl?: DocsWriteControl;
  returnJson?: boolean; // Default: false (human-readable summary)
}

export interface ReadDocumentOptions {
  tabId?: string; // Read one tab ("default" = the first tab)
  allTabs?: boolean; // Read every tab under one shared maxChars budget
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
  index: number; // 0-based position among siblings
  wordCount?: number;
  parentTabId: string | null;
  nestingLevel: number; // 0 = top-level tab
  path: string; // "Parent > Child"
  childCount: number;
}

export interface TabListResponse {
  documentId: string;
  title: string;
  tabs: TabInfo[];
}

export interface DocumentResponse {
  title: string;
  documentId: string;
  documentUrl: string;
  content?: string;
  truncated?: boolean;
  tabCount?: number; // every tab, all nesting levels
  tabs?: TabInfo[];
  revisionId?: string;
  shownTab?: { tabId: string; title: string }; // no-tab read: the first tab shown
  requestedTab?: { tabId: string; title: string; path: string; childCount?: number }; // tab_id read/edit target (childCount set on reads)
}

export interface DocsOperationResult {
  success: boolean;
  data?: DocumentResponse | DocsDocument | TabListResponse | TabJsonResponse | DocsBatchUpdateResponse;
  error?: string;
  occurrencesChanged?: number;
}

export interface ListTabsOptions {
  documentId: string;
  includeWordCount?: boolean;
}

export interface TabJsonResponse {
  documentId: string;
  title: string;
  revisionId?: string;
  tab: {
    tabProperties?: docs_v1.Schema$TabProperties;
    documentTab?: docs_v1.Schema$DocumentTab;
  };
  childTabs: Array<{ tabId: string; title: string }>; // listed only; read them by tab_id
}

export interface ExtractIdResult {
  success: boolean;
  documentId?: string;
  error?: string;
}
