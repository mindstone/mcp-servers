/**
 * Pure helpers for Google Docs tabs (no network).
 *
 * A Docs document is a tree of tabs: `doc.tabs[]`, each with `tabProperties`,
 * `documentTab` (the content) and `childTabs[]`. The API only returns that tree
 * when `documents.get` is called with `includeTabsContent: true`; without it the
 * legacy top-level `body` holds the first tab's content only.
 */
import { docs_v1 } from 'googleapis';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export const TRUNCATION_MARKER = '\n\n[TRUNCATED - document exceeds character limit]';

/**
 * Input error raised by the tab helpers (unknown tab id, refused `default`,
 * oversized JSON, …). Service catches rethrow it so the caller sees
 * InvalidParams instead of a generic API failure.
 */
export class DocsInputError extends McpError {
  constructor(message: string) {
    super(ErrorCode.InvalidParams, message);
    this.name = 'DocsInputError';
  }
}

export type FlatTab = {
  tabId: string;
  title: string;
  parentTabId: string | null;
  /** 0-based position among its siblings. */
  index: number;
  /** 0 = top-level tab. */
  nestingLevel: number;
  /** Titles from the top-level tab down, joined with " > ". */
  path: string;
  childCount: number;
  tab: docs_v1.Schema$Tab;
};

/**
 * Pre-order walk of the tab tree (parent before its children, siblings in order).
 */
export function flattenTabs(tabs: docs_v1.Schema$Tab[] | undefined): FlatTab[] {
  const out: FlatTab[] = [];
  const walk = (
    list: docs_v1.Schema$Tab[] | undefined,
    depth: number,
    parent: FlatTab | null
  ): void => {
    (list ?? []).forEach((tab, position) => {
      const props = tab.tabProperties ?? {};
      const title = props.title ?? '';
      const flat: FlatTab = {
        tabId: props.tabId ?? '',
        title,
        parentTabId: parent ? parent.tabId : null,
        index: props.index ?? position,
        nestingLevel: depth,
        path: parent ? `${parent.path} > ${title}` : title,
        childCount: tab.childTabs?.length ?? 0,
        tab,
      };
      out.push(flat);
      walk(tab.childTabs, depth + 1, flat);
    });
  };
  walk(tabs, 0, null);
  return out;
}

/**
 * `fields` mask for a tree-only read: tab properties down `depth` levels of
 * `childTabs`, no content. Docs nests far fewer levels than the default 6.
 */
export function buildTabTreeFields(depth = 6): string {
  const level = (remaining: number): string =>
    remaining <= 0 ? 'tabProperties' : `tabProperties,childTabs(${level(remaining - 1)})`;
  return `tabs(${level(depth)})`;
}

export const TAB_TREE_FIELDS = 'documentId,title,revisionId,' + buildTabTreeFields();

export const DEFAULT_TAB_REFUSED_MESSAGE =
  'Pass a real tab id from list_workspace_document_tabs; "default" is not accepted by tools that delete, move, rename or overwrite a tab.';

/**
 * Find a tab by id. `"default"` means the first top-level tab where
 * `allowDefault` is true and is refused otherwise. The error message never
 * echoes tab titles (they are untrusted document content).
 */
export function resolveTab(
  flat: FlatTab[],
  requested: string,
  opts: { allowDefault: boolean }
): FlatTab {
  if (requested === 'default') {
    if (!opts.allowDefault) {
      throw new DocsInputError(DEFAULT_TAB_REFUSED_MESSAGE);
    }
    const first = flat.find((tab) => tab.nestingLevel === 0);
    if (first) return first;
  } else {
    const match = flat.find((tab) => tab.tabId === requested);
    if (match) return match;
  }
  throw new DocsInputError(
    `Tab "${requested}" not found in this document. Call list_workspace_document_tabs to see tab ids.`
  );
}

function inlineElementText(
  element: docs_v1.Schema$ParagraphElement,
  renderInline: boolean
): string | undefined {
  if (element.textRun?.content) {
    return element.textRun.content;
  }
  if (!renderInline) {
    return undefined;
  }
  const richLink = element.richLink?.richLinkProperties;
  if (richLink) {
    return richLink.title || richLink.uri || undefined;
  }
  const person = element.person?.personProperties;
  if (person) {
    if (person.name && person.email) return `${person.name} <${person.email}>`;
    return person.name || person.email || undefined;
  }
  const date = element.dateElement?.dateElementProperties;
  if (date?.displayText) {
    return date.displayText;
  }
  return undefined;
}

const HEADING_MARKERS: Record<string, string> = {
  TITLE: '[Title] ',
  SUBTITLE: '[Subtitle] ',
  HEADING_1: '[H1] ',
  HEADING_2: '[H2] ',
  HEADING_3: '[H3] ',
  HEADING_4: '[H4] ',
  HEADING_5: '[H5] ',
  HEADING_6: '[H6] ',
};

/**
 * Read-only marker in front of a paragraph: a list item gets "• " (two spaces
 * of indent per nesting level), a heading gets "[H1] "…"[H6] ", "[Title] " or
 * "[Subtitle] ". Not `#`, so a heading can't be mistaken for an all_tabs
 * "## Tab:" line. The markers are not document text.
 */
function structureMarker(paragraph: docs_v1.Schema$Paragraph): string {
  const heading = HEADING_MARKERS[paragraph.paragraphStyle?.namedStyleType ?? ''] ?? '';
  if (!paragraph.bullet) {
    return heading;
  }
  return `${'  '.repeat(paragraph.bullet.nestingLevel ?? 0)}• ${heading}`;
}

/**
 * Plain text of a body (paragraphs and one level of table cells; a newline after
 * every table row). With no options the output matches the connector's original
 * first-tab extraction exactly. `renderInline` also emits smart chips in place:
 * rich-link title (or URI), person name and email, date display text.
 * `markStructure` prefixes list items and headings with a read-only marker
 * (see structureMarker).
 */
export function extractBodyText(
  body: docs_v1.Schema$Body | undefined,
  opts: { renderInline?: boolean; markStructure?: boolean } = {}
): string {
  if (!body?.content) {
    return '';
  }

  const renderInline = opts.renderInline === true;
  const markStructure = opts.markStructure === true;
  const textParts: string[] = [];
  const pushParagraph = (paragraph: docs_v1.Schema$Paragraph | undefined): void => {
    if (markStructure && paragraph?.elements?.length) {
      const marker = structureMarker(paragraph);
      if (marker) textParts.push(marker);
    }
    for (const paragraphElement of paragraph?.elements ?? []) {
      const text = inlineElementText(paragraphElement, renderInline);
      if (text) {
        textParts.push(text);
      }
    }
  };

  for (const element of body.content) {
    if (element.paragraph?.elements) {
      pushParagraph(element.paragraph);
    } else if (element.table) {
      // Extract text from table cells
      for (const row of element.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          for (const cellElement of cell.content ?? []) {
            if (cellElement.paragraph?.elements) {
              pushParagraph(cellElement.paragraph);
            }
          }
        }
        textParts.push('\n'); // Row separator
      }
    }
  }

  return textParts.join('');
}

/** Text options of `tab_id` / `all_tabs` reads (the no-tab read passes none). */
export const TAB_READ_TEXT_OPTIONS = { renderInline: true, markStructure: true } as const;

/**
 * Characters the Docs API strips from `insertText`: control characters
 * U+0000–U+0008 and U+000C–U+001F, and the BMP private-use area U+E000–U+F8FF.
 * Tab (U+0009), newline (U+000A) and U+000B (a line break inside a paragraph)
 * are kept. Carriage returns are handled before this, as line endings.
 */
const DOCS_STRIPPED_CHARS = /[\u0000-\u0008\u000C-\u001F-]/g;

/**
 * The text exactly as Docs will store it, so offsets computed from its length
 * (the style-clear range, the reported count) cover only the inserted text.
 * "\r\n" and a lone "\r" become "\n"; characters Docs would strip are removed
 * and counted.
 */
export function normalizeInsertText(text: string): { text: string; removedChars: number } {
  const lineEndings = text.replace(/\r\n?/g, '\n');
  const normalized = lineEndings.replace(DOCS_STRIPPED_CHARS, '');
  return { text: normalized, removedChars: lineEndings.length - normalized.length };
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * Index to insert at the end of a body (before its final newline).
 */
export function bodyEndIndex(body: docs_v1.Schema$Body | undefined): number {
  if (!body?.content || body.content.length === 0) {
    return 1;
  }

  // Find the last structural element and get its end index
  const lastElement = body.content[body.content.length - 1];
  return (lastElement.endIndex ?? 1) - 1; // -1 to insert before final newline
}

/**
 * The tab tree of an `includeTabsContent` read. Fails loudly instead of falling
 * back to the legacy single-body view.
 */
export function requireTabs(doc: docs_v1.Schema$Document): docs_v1.Schema$Tab[] {
  if (!doc.tabs) {
    throw new Error('Docs API returned no tabs for an includeTabsContent read');
  }
  return doc.tabs;
}

/**
 * Refuse a tab title that another tab already uses. Docs requires tab titles
 * to be unique across the whole document, sub-tabs included. Comparison is
 * exact after trimming both sides. Echoing the caller's own title is fine; no
 * document title is echoed.
 */
export function assertUniqueTitle(flat: FlatTab[], title: string, exceptTabId?: string): void {
  const wanted = title.trim();
  const clash = flat.find((tab) => tab.tabId !== exceptTabId && tab.title.trim() === wanted);
  if (clash) {
    throw new DocsInputError(
      `A tab titled "${wanted}" already exists. Tab titles must be unique across the whole document, including sub-tabs.`
    );
  }
}

/**
 * Every tab below `tabId` (children, grandchildren, …) in tree order.
 */
export function descendantsOf(flat: FlatTab[], tabId: string): FlatTab[] {
  const start = flat.findIndex((tab) => tab.tabId === tabId);
  if (start < 0) return [];
  const depth = flat[start].nestingLevel;
  const out: FlatTab[] = [];
  // Pre-order: descendants follow the tab until the walk climbs back to its depth.
  for (let i = start + 1; i < flat.length && flat[i].nestingLevel > depth; i++) {
    out.push(flat[i]);
  }
  return out;
}

/**
 * The tabs directly under `parentTabId` (`null` = top level), in position order.
 */
export function siblingsOf(flat: FlatTab[], parentTabId: string | null): FlatTab[] {
  return flat
    .filter((tab) => tab.parentTabId === parentTabId)
    .sort((a, b) => a.index - b.index);
}

/** Every character-style field, for clearing a range's text style with `updateTextStyle`. */
export const ALL_TEXT_KEYS =
  'bold,italic,underline,strikethrough,smallCaps,fontSize,foregroundColor,backgroundColor,weightedFontFamily,baselineOffset,link';

/** Where a paragraph lives: the tab body, or one table cell (table = n-th table in the body). */
export type ParagraphContainer = 'body' | { table: number; row: number; col: number };

export type FlatParagraph = {
  paragraph: docs_v1.Schema$Paragraph;
  container: ParagraphContainer;
  startIndex: number;
  endIndex: number;
  /** Position of the paragraph's structural element in `body.content` (body paragraphs only). */
  bodyElementIndex?: number;
};

/**
 * Body paragraphs and table-cell paragraphs, in document order (one level of
 * tables, like the text extraction).
 */
export function flatParagraphs(body: docs_v1.Schema$Body | undefined): FlatParagraph[] {
  const out: FlatParagraph[] = [];
  let tableNumber = 0;
  (body?.content ?? []).forEach((element, bodyElementIndex) => {
    if (element.paragraph) {
      out.push({
        paragraph: element.paragraph,
        container: 'body',
        startIndex: element.startIndex ?? 0,
        endIndex: element.endIndex ?? 0,
        bodyElementIndex,
      });
    } else if (element.table) {
      (element.table.tableRows ?? []).forEach((row, rowIndex) => {
        (row.tableCells ?? []).forEach((cell, colIndex) => {
          for (const cellElement of cell.content ?? []) {
            if (cellElement.paragraph) {
              out.push({
                paragraph: cellElement.paragraph,
                container: { table: tableNumber, row: rowIndex, col: colIndex },
                startIndex: cellElement.startIndex ?? 0,
                endIndex: cellElement.endIndex ?? 0,
              });
            }
          }
        });
      });
      tableNumber++;
    }
  });
  return out;
}

/** Object-replacement character standing in for one index of a non-text element. */
const NON_TEXT_PLACEHOLDER = '￼';

/**
 * Searchable text of a paragraph whose string offsets equal document-index
 * offsets: text runs as they are (JS strings count UTF-16 units, like the Docs
 * API), every other element (smart chip, person, date, image, …) as one
 * placeholder character per index it occupies, so it can never match an anchor.
 */
export function paragraphSearchText(paragraph: docs_v1.Schema$Paragraph): string {
  return (paragraph.elements ?? [])
    .map((element) => {
      if (element.textRun) {
        return element.textRun.content ?? '';
      }
      const span =
        element.startIndex != null && element.endIndex != null
          ? element.endIndex - element.startIndex
          : 1;
      return NON_TEXT_PLACEHOLDER.repeat(Math.max(0, span));
    })
    .join('');
}

/**
 * Case-insensitive comparison one UTF-16 unit at a time, so case folding that
 * changes a string's length (e.g. "İ" lower-cases to two units) can never shift
 * the match offset.
 */
function sameCharIgnoringCase(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase() || a.toUpperCase() === b.toUpperCase();
}

export type AnchorMatch = { paragraphIdx: number; offset: number };

/**
 * Every place `anchor` occurs inside a single paragraph. Anchors never span
 * paragraphs; an anchor containing a newline is refused.
 */
export function findAnchor(
  paragraphs: FlatParagraph[],
  anchor: string,
  matchCase: boolean
): AnchorMatch[] {
  if (anchor.length === 0) {
    throw new DocsInputError('anchor_text must not be empty.');
  }
  if (anchor.includes('\n') || anchor.includes('\r')) {
    throw new DocsInputError('anchor_text must be on one line.');
  }
  const matches: AnchorMatch[] = [];
  paragraphs.forEach((entry, paragraphIdx) => {
    const text = paragraphSearchText(entry.paragraph);
    for (let offset = 0; offset + anchor.length <= text.length; offset++) {
      let hit = true;
      for (let i = 0; i < anchor.length; i++) {
        const a = text[offset + i];
        const b = anchor[i];
        if (matchCase ? a !== b : !sameCharIgnoringCase(a, b)) {
          hit = false;
          break;
        }
      }
      if (hit) {
        matches.push({ paragraphIdx, offset });
      }
    }
  });
  return matches;
}

const NEXT_PARAGRAPH_MISSING_MESSAGE =
  'The anchor paragraph is followed by a table (or nothing); use position "after" instead.';

/**
 * Index of the start of the paragraph after `paragraphs[paragraphIdx]` in the
 * same container: in the body, the next body element must be a paragraph; in a
 * table cell, the next paragraph of the same cell.
 */
export function nextParagraphInContainer(
  body: docs_v1.Schema$Body | undefined,
  paragraphs: FlatParagraph[],
  paragraphIdx: number
): FlatParagraph {
  const current = paragraphs[paragraphIdx];
  if (current.container === 'body') {
    const nextElementIndex = (current.bodyElementIndex ?? -1) + 1;
    const nextElement = body?.content?.[nextElementIndex];
    const next = nextElement?.paragraph
      ? paragraphs.find((entry) => entry.bodyElementIndex === nextElementIndex)
      : undefined;
    if (!next) {
      throw new DocsInputError(NEXT_PARAGRAPH_MISSING_MESSAGE);
    }
    return next;
  }
  const cell = current.container;
  const next = paragraphs[paragraphIdx + 1];
  if (
    !next ||
    next.container === 'body' ||
    next.container.table !== cell.table ||
    next.container.row !== cell.row ||
    next.container.col !== cell.col
  ) {
    throw new DocsInputError(NEXT_PARAGRAPH_MISSING_MESSAGE);
  }
  return next;
}

/** Marker for the one tab an `all_tabs` read cuts at the shared budget. */
export const TAB_TRUNCATION_MARKER = '\n\n[TRUNCATED - this tab continues past the max_chars budget]';

/**
 * Text of every tab, in tree order, under `## Tab:` headings. `maxChars` is one
 * budget for tab text shared across all tabs; headings and the final
 * "not shown in full" list sit outside it. The tab that crosses the budget is
 * cut with the tab truncation marker; it heads the final list (marked
 * "cut short"), followed by every later tab by path and id.
 */
export function buildAllTabsText(
  flat: FlatTab[],
  maxChars: number
): { content: string; truncated: boolean; shownCount: number } {
  const blocks: string[] = [];
  let used = 0;
  let cut: FlatTab | undefined;
  let next = 0;

  for (; next < flat.length; next++) {
    const remaining = maxChars - used;
    if (remaining <= 0) {
      break;
    }
    const tab = flat[next];
    const heading = `## Tab: ${tab.path} [tabId: ${tab.tabId}]`;
    const text = extractBodyText(tab.tab.documentTab?.body, TAB_READ_TEXT_OPTIONS);
    if (text.length > remaining) {
      blocks.push(`${heading}\n${text.substring(0, remaining)}${TAB_TRUNCATION_MARKER}\n`);
      cut = tab;
      next++;
      break;
    }
    blocks.push(`${heading}\n${text}\n`);
    used += text.length;
  }

  const listed = [
    ...(cut ? [`- ${cut.path} [tabId: ${cut.tabId}] (cut short)`] : []),
    ...flat.slice(next).map((tab) => `- ${tab.path} [tabId: ${tab.tabId}]`),
  ];

  // Tab blocks end with their own newline; the final list is newline-joined.
  let content = blocks.join('');
  if (listed.length > 0) {
    content += ['\n[Not shown in full — over the max_chars budget; read them with tab_id]:', ...listed].join('\n');
  }
  return { content, truncated: listed.length > 0, shownCount: next };
}
