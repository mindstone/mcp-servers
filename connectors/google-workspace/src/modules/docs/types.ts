import { docs_v1 } from 'googleapis';
import type { ChipFallback, CopyVerification } from './tabCopy.js';

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

export interface AddTabOptions {
  documentId: string;
  title: string;
  parentTabId?: string; // "default" = the first top-level tab
  position?: number; // 0-based among the new siblings; default: end
}

export interface UpdateTabOptions {
  documentId: string;
  tabId: string; // "default" refused
  title?: string;
  parentTabId?: string; // "default" refused
  position?: number; // 0-based final position among the destination siblings
}

export interface DeleteTabOptions {
  documentId: string;
  tabId: string; // "default" refused
  deleteSubTabs?: boolean; // required to delete a tab that has sub-tabs
}

export type InsertTextPosition = 'after' | 'before' | 'next_paragraph_start';

export interface InsertTextOptions {
  documentId: string;
  tabId?: string; // default: the first tab
  anchorText: string;
  position: InsertTextPosition;
  text: string;
  matchCase: boolean;
  expectEmptyParagraph?: boolean; // default: true for next_paragraph_start, false otherwise
}

export interface TabRef {
  tabId: string;
  title: string;
  path: string;
}

/** Result of add / update: the tab as the document reports it after the write. */
export interface TabWriteResponse {
  documentId: string;
  tab: TabInfo;
  /** The tab's parent after the write; null = top level. */
  parent: TabRef | null;
  /** Update only: false when nothing would change, so no write was sent. */
  changed: boolean;
  /** The position the caller asked for, or the default that was applied. */
  requestedPosition: number;
  /** The parent the caller asked for (null = top level). */
  requestedParentTabId: string | null;
}

export interface TabDeleteResponse {
  documentId: string;
  deleted: TabRef;
  /** Sub-tabs deleted with it, in tree order. */
  descendants: TabRef[];
}

export interface InsertTextResponse {
  documentId: string;
  tab: TabRef;
  position: InsertTextPosition;
  index: number;
  /** Characters inserted, as Docs stores them (after normalisation). */
  insertedChars: number;
  /** Control or private-use characters left out because Docs would strip them. */
  removedChars: number;
  newParagraphs: number;
  /** The paragraph the text landed in, as read before the write. */
  targetParagraph: { wasEmpty: boolean; namedStyleType: string; bulleted: boolean };
}

export interface CopyTabOptions {
  documentId: string;
  sourceTabId: string; // "default" = the first top-level tab
  targetTabId?: string; // existing tab, cleared first; "default" refused
  overwriteExisting?: boolean; // required with targetTabId
  newTabTitle?: string;
  newTabParentId?: string; // "default" = the first top-level tab
  newTabPosition?: number; // 0-based among the new tab's siblings; default: end
}

/** Result of copy_workspace_document_tab. */
export interface TabCopyResponse {
  documentId: string;
  mode: 'new' | 'overwrite';
  source: TabRef;
  target: TabRef;
  requests: number;
  rounds: number;
  durationMs: number;
  chipsCopied: number;
  chipFallbacks: ChipFallback[];
  convertedToText: { people: number; dates: number };
  namedStylesCopied: number;
  notCopied: Record<string, number>;
  notes: string[];
  verification: CopyVerification;
}

export interface DocsOperationResult {
  success: boolean;
  data?:
    | DocumentResponse
    | DocsDocument
    | TabListResponse
    | TabJsonResponse
    | DocsBatchUpdateResponse
    | TabWriteResponse
    | TabDeleteResponse
    | InsertTextResponse
    | TabCopyResponse;
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
