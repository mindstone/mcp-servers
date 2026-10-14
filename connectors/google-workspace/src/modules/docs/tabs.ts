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

/**
 * Plain text of a body (paragraphs and one level of table cells; a newline after
 * every table row). With no options the output matches the connector's original
 * first-tab extraction exactly. `renderInline` also emits smart chips in place:
 * rich-link title (or URI), person name and email, date display text.
 */
export function extractBodyText(
  body: docs_v1.Schema$Body | undefined,
  opts: { renderInline?: boolean } = {}
): string {
  if (!body?.content) {
    return '';
  }

  const renderInline = opts.renderInline === true;
  const textParts: string[] = [];
  const pushParagraph = (paragraph: docs_v1.Schema$Paragraph | undefined): void => {
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
    const text = extractBodyText(tab.tab.documentTab?.body, { renderInline: true });
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
