/**
 * Copy one Docs tab's content into another tab of the same document.
 *
 * The Docs API has no "copy tab" request, so the copy is rebuilt from a
 * `documents.get` read of the source in dependent rounds of `batchUpdate`
 * (indices only exist after the previous round has been applied):
 *
 *   Phase 0  clear the target, copy page setup and named styles
 *   Phase 1  skeleton: text, smart chips, page breaks and empty tables, in order
 *   Phase 2  table cell text, filled in reverse order
 *   Phase 3  paragraph styles, run styles and bullets, per unit, last unit first
 *   Phase 3b re-apply bullet paragraphs' paragraph styles (bullets reset them)
 *   Phase 4  table column widths and cell styles
 *   then a verification read compares the result with the source.
 *
 * The planners below are pure (documents.get JSON in, batchUpdate requests out)
 * and the orchestrator `copyTabContent` takes its I/O as injected dependencies,
 * so the whole algorithm is testable without the API. Ordering rules that the
 * API depends on (learned against the live API, do not reorder):
 * - Within a paragraph: paragraph style (incl. namedStyleType) first, then the
 *   text-style clear, then run styles, then bullets. Re-applying namedStyleType
 *   wipes run styles.
 * - createParagraphBullets removes the leading tabs that set nesting and resets
 *   indents/spacing, so units are sent last-first and bullet paragraphs get
 *   their paragraph style re-applied (without namedStyleType) afterwards.
 * - insertTable adds its own newline before the table; insertPageBreak adds a
 *   newline after the break; empty insertText is rejected.
 * - insertRichLink fails the whole batch when the caller can't open the linked
 *   file, so every chip is checked first and falls back to a titled link.
 */
import { docs_v1 } from 'googleapis';
import { ALL_TEXT_KEYS, DocsInputError, ParagraphContainer, flatParagraphs } from './tabs.js';

type Tab = docs_v1.Schema$Tab;
type Paragraph = docs_v1.Schema$Paragraph;
type TextStyle = docs_v1.Schema$TextStyle;
type StructuralElement = docs_v1.Schema$StructuralElement;

/** Requests per batchUpdate call. */
export const CHUNK = 150;
/** Paragraph-style fields never copied (a heading id belongs to the source paragraph). */
export const PSTYLE_DROP: readonly string[] = ['headingId'];
/** Dropped from bullet paragraphs in Phase 3: createParagraphBullets sets its own indents. */
const BULLET_INDENT_DROP: readonly string[] = ['indentStart', 'indentFirstLine'];
/**
 * Document-style (page setup) fields copied in Phase 0. Never
 * `useCustomHeaderFooterMargins`: the API rejects it in updateDocumentStyle.
 */
export const DOCUMENT_STYLE_KEYS = [
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'pageSize',
  'marginHeader',
  'marginFooter',
  'pageNumberStart',
] as const;
const NAMED_STYLE_FIELDS = 'namedStyleType,textStyle,paragraphStyle';

/**
 * A Docs request, plus the two request types the googleapis 171.4.0 typings
 * lack (both are documented by Google; insertRichLink is proven live).
 */
export type TabCopyRequest = docs_v1.Schema$Request & {
  insertRichLink?: {
    location?: docs_v1.Schema$Location;
    endOfSegmentLocation?: docs_v1.Schema$EndOfSegmentLocation;
    richLinkProperties: { uri: string };
  };
  updateNamedStyle?: { tabId?: string; namedStyle: docs_v1.Schema$NamedStyle; fields: string };
};

/** One piece of a source paragraph, with its length in the target (UTF-16 units). */
export type Piece =
  | {
      kind: 'text';
      text: string;
      length: number;
      style?: TextStyle;
      /** Leading tabs that set a bullet's nesting level (createParagraphBullets removes them). */
      nesting?: true;
      /** A visible "[kind]" stand-in for an element that can't be copied. */
      placeholder?: true;
    }
  | { kind: 'chip'; uri: string; length: 1; style: TextStyle }
  | { kind: 'pagebreak'; length: 1; style: TextStyle };

export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'chip'; uri: string }
  | { kind: 'pagebreak' }
  | { kind: 'table'; rows: number; columns: number };

export type SourceParagraph = {
  container: ParagraphContainer;
  paragraph: Paragraph;
  pieces: Piece[];
};

export type ChipFallback = { uri: string; title: string };

export interface SourcePlan {
  /** Body and table-cell paragraphs in document order (the order flatParagraphs gives the target). */
  paragraphs: SourceParagraph[];
  /** Phase 1 tokens, appended at the end of the target in order. */
  bodyTokens: Token[];
  tables: docs_v1.Schema$Table[];
  /** Phase 2 tokens per cell: cellTokens[table][row][col], trailing newline stripped. */
  cellTokens: Token[][][][];
  lists: Record<string, docs_v1.Schema$List>;
  chipsCopied: number;
  /** One entry per distinct URI. */
  chipFallbacks: ChipFallback[];
  convertedToText: { people: number; dates: number };
  placeholders: number;
  /** Element kinds (or "merged table cells") that were not copied, with counts. */
  notCopied: Record<string, number>;
  notes: string[];
}

export interface CopyMismatch {
  /** 0-based paragraph (body and table-cell paragraphs, in document order). */
  paragraphIndex?: number;
  /** 0-based table in the tab body. */
  tableIndex?: number;
  kind: string;
}

export interface CopyVerification {
  passed: boolean;
  checkedParagraphs: number;
  tables: number;
  lists: number;
  placeholders: number;
  mismatchCount: number;
  /** The first few mismatches (indices and kinds only, never text). */
  mismatches: CopyMismatch[];
}

export interface TabCopyResult {
  targetTabId: string;
  requests: number;
  rounds: number;
  chipsCopied: number;
  chipFallbacks: ChipFallback[];
  convertedToText: { people: number; dates: number };
  namedStylesCopied: number;
  notCopied: Record<string, number>;
  notes: string[];
  verification: CopyVerification;
}

export interface TabCopyDeps {
  /** Committed content only: pending suggestions are left out (PREVIEW_WITHOUT_SUGGESTIONS). */
  getSourceTab(): Promise<Tab>;
  /** A fresh read of a tab (default view, so indices are valid for writes). */
  getTab(tabId: string): Promise<Tab>;
  batchUpdate(requests: TabCopyRequest[]): Promise<void>;
  /** Whether the caller can open the file a smart chip links to. */
  checkChip(uri: string): Promise<boolean>;
  /**
   * Called once, after the source is read and every chip checked and before
   * the first content write. Returns the target tab id (new-tab mode creates
   * the tab here).
   */
  prepareTarget(): Promise<string>;
}

/**
 * A failure inside the copy, naming the phase, whether a content write was
 * confirmed (`wroteContent`) and whether one had been sent at all
 * (`attemptedWrite`: a write whose reply was lost may still have applied).
 */
export class TabCopyError extends Error {
  constructor(
    readonly phase: string,
    readonly wroteContent: boolean,
    readonly attemptedWrite: boolean,
    readonly cause: unknown
  ) {
    super(`Copy failed during "${phase}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TabCopyError';
  }
}

/** Drive file id of a Docs/Sheets/Slides/Drive link (`/d/<id>`), or null. */
export function idFromUri(uri: string): string | null {
  const match = /\/d\/([A-Za-z0-9_-]+)/.exec(uri);
  return match ? match[1] : null;
}

function elementKind(element: object): string {
  return Object.keys(element).find((key) => key !== 'startIndex' && key !== 'endIndex') ?? 'unknown';
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function hasKeys(style: object | undefined): style is object {
  return style !== undefined && Object.keys(style).length > 0;
}

/** JSON-shape equality for API objects (key order ignored). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const bKeys = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function sameContainer(a: ParagraphContainer, b: ParagraphContainer): boolean {
  if (a === 'body' || b === 'body') return a === b;
  return a.table === b.table && a.row === b.row && a.col === b.col;
}

/** Cell paragraphs of a body (one level of tables), like flatParagraphs. */
function forEachCellParagraph(
  content: StructuralElement[] | undefined,
  visit: (paragraph: Paragraph) => void
): void {
  for (const element of content ?? []) {
    if (element.paragraph) visit(element.paragraph);
  }
}

/**
 * Every smart-chip URI in the tab (body and table cells), in document order,
 * without duplicates. Collected before any write so each one is checked once.
 */
export function collectChipUris(tab: Tab): string[] {
  const uris = new Set<string>();
  const fromParagraph = (paragraph: Paragraph): void => {
    for (const element of paragraph.elements ?? []) {
      const uri = element.richLink?.richLinkProperties?.uri;
      if (uri) uris.add(uri);
    }
  };
  for (const element of tab.documentTab?.body?.content ?? []) {
    if (element.paragraph) fromParagraph(element.paragraph);
    for (const row of element.table?.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) forEachCellParagraph(cell.content, fromParagraph);
    }
  }
  return [...uris];
}

/**
 * Docs bullet preset for a source list. Only preset styles can be created, so
 * the first nesting level's glyph decides: decimal numbering, letter
 * numbering, or discs (●/○/■ or no symbol; an unknown symbol also becomes
 * discs, with a note).
 */
export function presetFor(list: docs_v1.Schema$List | undefined, notes: string[]): string {
  const level = list?.listProperties?.nestingLevels?.[0] ?? {};
  const glyphType = level.glyphType ?? undefined;
  const glyphSymbol = level.glyphSymbol ?? undefined;
  if (glyphType === 'DECIMAL' || glyphType === 'ZERO_DECIMAL') return 'NUMBERED_DECIMAL_ALPHA_ROMAN';
  if (glyphType === 'ALPHA' || glyphType === 'UPPER_ALPHA') return 'NUMBERED_UPPERALPHA_ALPHA_ROMAN';
  if (glyphSymbol === undefined || ['●', '○', '■'].includes(glyphSymbol)) {
    if (glyphSymbol === undefined && glyphType !== undefined && !['GLYPH_TYPE_UNSPECIFIED', 'NONE'].includes(glyphType)) {
      // Same mapping as before (discs); say so rather than change a numbered list silently.
      notes.push(`numbered list style ${glyphType} copied as bullets`);
    }
    return 'BULLET_DISC_CIRCLE_SQUARE';
  }
  notes.push(`unmapped glyph ${glyphType ?? 'none'}/${glyphSymbol}`);
  return 'BULLET_DISC_CIRCLE_SQUARE';
}

function addText(tokens: Token[], text: string): void {
  const last = tokens[tokens.length - 1];
  if (last?.kind === 'text') {
    tokens[tokens.length - 1] = { kind: 'text', text: last.text + text };
  } else {
    tokens.push({ kind: 'text', text });
  }
}

/** Append a paragraph's pieces as tokens; text right after a page break loses its leading newline. */
function tokensForParagraph(pieces: Piece[], tokens: Token[]): void {
  let afterPageBreak = false;
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      const text = afterPageBreak && piece.text.startsWith('\n') ? piece.text.slice(1) : piece.text;
      afterPageBreak = false;
      if (text) addText(tokens, text);
    } else if (piece.kind === 'chip') {
      tokens.push({ kind: 'chip', uri: piece.uri });
      afterPageBreak = false;
    } else {
      tokens.push({ kind: 'pagebreak' });
      afterPageBreak = true;
    }
  }
}

/** Drop the trailing newline of the last text token; true when there was one. */
function stripTrailingNewline(tokens: Token[]): boolean {
  const last = tokens[tokens.length - 1];
  if (last?.kind === 'text' && last.text.endsWith('\n')) {
    tokens[tokens.length - 1] = { kind: 'text', text: last.text.slice(0, -1) };
    return true;
  }
  return false;
}

/**
 * Plan the source tab: every paragraph's pieces (computed exactly once and
 * reused by Phases 1-3 and verification), the Phase 1 and Phase 2 tokens, and
 * the report counts. `chipAccess` holds the result of the per-URI access check;
 * a URI that is missing or false falls back to a titled link.
 */
export function buildSourcePlan(sourceTab: Tab, chipAccess: ReadonlyMap<string, boolean>): SourcePlan {
  const documentTab = sourceTab.documentTab ?? {};
  const plan: SourcePlan = {
    paragraphs: [],
    bodyTokens: [],
    tables: [],
    cellTokens: [],
    lists: (documentTab.lists ?? {}) as Record<string, docs_v1.Schema$List>,
    chipsCopied: 0,
    chipFallbacks: [],
    convertedToText: { people: 0, dates: 0 },
    placeholders: 0,
    notCopied: {},
    notes: [],
  };
  const fallbackUris = new Set<string>();

  const placeholder = (kind: string): Piece => {
    const text = `[${kind}]`;
    bump(plan.notCopied, kind);
    plan.placeholders++;
    return { kind: 'text', text, length: text.length, style: {}, placeholder: true };
  };

  const piecesFor = (paragraph: Paragraph): Piece[] => {
    // Floating images sit outside paragraph.elements: counted, never copied, no placeholder.
    const floating = paragraph.positionedObjectIds?.length ?? 0;
    if (floating > 0) plan.notCopied['positionedObject'] = (plan.notCopied['positionedObject'] ?? 0) + floating;
    const pieces: Piece[] = [];
    const nest = paragraph.bullet ? paragraph.bullet.nestingLevel ?? 0 : 0;
    if (nest) pieces.push({ kind: 'text', text: '\t'.repeat(nest), length: nest, nesting: true });
    for (const element of paragraph.elements ?? []) {
      if (element.textRun) {
        const text = element.textRun.content ?? '';
        pieces.push({ kind: 'text', text, length: text.length, style: element.textRun.textStyle ?? {} });
      } else if (element.richLink) {
        const props = element.richLink.richLinkProperties ?? {};
        const style = element.richLink.textStyle ?? {};
        const uri = props.uri ?? '';
        if (!uri) {
          pieces.push(placeholder('richLink'));
        } else if (chipAccess.get(uri) === true) {
          pieces.push({ kind: 'chip', uri, length: 1, style });
          plan.chipsCopied++;
        } else {
          const title = props.title || uri;
          if (!fallbackUris.has(uri)) {
            fallbackUris.add(uri);
            plan.chipFallbacks.push({ uri, title });
          }
          pieces.push({ kind: 'text', text: title, length: title.length, style: { ...style, link: { url: uri } } });
        }
      } else if (element.pageBreak) {
        pieces.push({ kind: 'pagebreak', length: 1, style: element.pageBreak.textStyle ?? {} });
      } else if (element.person) {
        const props = element.person.personProperties ?? {};
        const text = props.name || props.email;
        if (!text) {
          pieces.push(placeholder('person'));
        } else {
          const style = element.person.textStyle ?? {};
          pieces.push({
            kind: 'text',
            text,
            length: text.length,
            style: props.email ? { ...style, link: { url: `mailto:${props.email}` } } : style,
          });
          plan.convertedToText.people++;
        }
      } else if (element.dateElement) {
        const text = element.dateElement.dateElementProperties?.displayText;
        if (!text) {
          pieces.push(placeholder('dateElement'));
        } else {
          pieces.push({ kind: 'text', text, length: text.length, style: element.dateElement.textStyle ?? {} });
          plan.convertedToText.dates++;
        }
      } else {
        pieces.push(placeholder(elementKind(element)));
      }
    }
    return pieces;
  };

  for (const element of documentTab.body?.content ?? []) {
    if (element.sectionBreak) continue;
    if (element.paragraph) {
      const pieces = piecesFor(element.paragraph);
      plan.paragraphs.push({ container: 'body', paragraph: element.paragraph, pieces });
      tokensForParagraph(pieces, plan.bodyTokens);
    } else if (element.table) {
      const table = element.table;
      // insertTable always builds a full rows x columns grid, so a ragged table could never match.
      const tableRows = table.tableRows ?? [];
      if (
        tableRows.length !== (table.rows ?? 0) ||
        tableRows.some((row) => (row.tableCells ?? []).length !== (table.columns ?? 0))
      ) {
        throw new DocsInputError(
          "This tab has a table with merged cells in a shape that can't be copied. Nothing was written."
        );
      }
      const tableNumber = plan.tables.length;
      plan.tables.push(table);
      if (!stripTrailingNewline(plan.bodyTokens)) plan.notes.push('table without preceding newline');
      plan.bodyTokens.push({ kind: 'table', rows: table.rows ?? 0, columns: table.columns ?? 0 });
      let merged = false;
      const rowTokens: Token[][][] = [];
      (table.tableRows ?? []).forEach((row, rowIndex) => {
        const colTokens: Token[][] = [];
        (row.tableCells ?? []).forEach((cell, colIndex) => {
          const style = cell.tableCellStyle;
          if ((style?.rowSpan ?? 1) > 1 || (style?.columnSpan ?? 1) > 1) merged = true;
          const tokens: Token[] = [];
          for (const cellElement of cell.content ?? []) {
            if (cellElement.paragraph) {
              const pieces = piecesFor(cellElement.paragraph);
              plan.paragraphs.push({
                container: { table: tableNumber, row: rowIndex, col: colIndex },
                paragraph: cellElement.paragraph,
                pieces,
              });
              tokensForParagraph(pieces, tokens);
            } else if (cellElement.table) {
              bump(plan.notCopied, 'table inside a table cell');
            }
          }
          stripTrailingNewline(tokens);
          colTokens.push(tokens);
        });
        rowTokens.push(colTokens);
      });
      plan.cellTokens.push(rowTokens);
      if (merged) bump(plan.notCopied, 'merged table cells');
    } else {
      bump(plan.notCopied, elementKind(element));
    }
  }
  stripTrailingNewline(plan.bodyTokens);
  return plan;
}

/**
 * Phase 0: clear the target body, reset its remaining paragraph (no bullet,
 * NORMAL_TEXT, no character style), copy page setup and any named style that
 * differs from the target's.
 */
export function planClear(
  sourceTab: Tab,
  targetTab: Tab,
  targetTabId: string
): { requests: TabCopyRequest[]; namedStylesCopied: number } {
  const requests: TabCopyRequest[] = [];
  const content = targetTab.documentTab?.body?.content ?? [];
  const end = content.length > 0 ? content[content.length - 1].endIndex ?? 1 : 1;
  if (end > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId: targetTabId } } });
  }
  const first = { startIndex: 1, endIndex: 2, tabId: targetTabId };
  requests.push(
    { deleteParagraphBullets: { range: first } },
    {
      updateParagraphStyle: {
        range: first,
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        fields: 'namedStyleType',
      },
    },
    { updateTextStyle: { range: first, textStyle: {}, fields: ALL_TEXT_KEYS } }
  );

  const sourceDocStyle = sourceTab.documentTab?.documentStyle ?? {};
  const keys = DOCUMENT_STYLE_KEYS.filter((key) => sourceDocStyle[key] !== undefined && sourceDocStyle[key] !== null);
  if (keys.length > 0) {
    const documentStyle: docs_v1.Schema$DocumentStyle = {};
    for (const key of keys) {
      (documentStyle as Record<string, unknown>)[key] = sourceDocStyle[key];
    }
    requests.push({ updateDocumentStyle: { tabId: targetTabId, documentStyle, fields: keys.join(',') } });
  }

  const targetStyles = new Map(
    (targetTab.documentTab?.namedStyles?.styles ?? []).map((style) => [style.namedStyleType, style])
  );
  let namedStylesCopied = 0;
  for (const style of sourceTab.documentTab?.namedStyles?.styles ?? []) {
    if (!deepEqual(style, targetStyles.get(style.namedStyleType))) {
      requests.push({ updateNamedStyle: { tabId: targetTabId, namedStyle: style, fields: NAMED_STYLE_FIELDS } });
      namedStylesCopied++;
    }
  }
  return { requests, namedStylesCopied };
}

/** Phase 1: the skeleton, appended at the end of the target in document order. */
export function planSkeleton(plan: SourcePlan, targetTabId: string): TabCopyRequest[] {
  const endOfSegmentLocation = { tabId: targetTabId };
  const requests: TabCopyRequest[] = [];
  for (const token of plan.bodyTokens) {
    if (token.kind === 'text') {
      if (token.text) requests.push({ insertText: { endOfSegmentLocation, text: token.text } });
    } else if (token.kind === 'chip') {
      requests.push({ insertRichLink: { endOfSegmentLocation, richLinkProperties: { uri: token.uri } } });
    } else if (token.kind === 'pagebreak') {
      requests.push({ insertPageBreak: { endOfSegmentLocation } });
    } else {
      requests.push({ insertTable: { endOfSegmentLocation, rows: token.rows, columns: token.columns } });
    }
  }
  return requests;
}

function bodyTables(tab: Tab): StructuralElement[] {
  return (tab.documentTab?.body?.content ?? []).filter((element) => element.table);
}

/**
 * Phase 2: fill table cells, last table / row / column first and each cell's
 * tokens in reverse, all at the cell's first index, so no insert shifts an
 * index still to be used.
 */
export function planTableCells(plan: SourcePlan, targetTab: Tab, targetTabId: string): TabCopyRequest[] {
  const targetTables = bodyTables(targetTab);
  if (targetTables.length !== plan.tables.length) {
    throw new Error(`table count mismatch after the skeleton: source ${plan.tables.length}, target ${targetTables.length}`);
  }
  const requests: TabCopyRequest[] = [];
  for (let t = plan.tables.length - 1; t >= 0; t--) {
    const targetRows = targetTables[t].table?.tableRows ?? [];
    const rows = plan.cellTokens[t];
    for (let r = rows.length - 1; r >= 0; r--) {
      for (let c = rows[r].length - 1; c >= 0; c--) {
        const at = targetRows[r]?.tableCells?.[c]?.content?.[0]?.startIndex;
        if (at === undefined || at === null) {
          throw new Error(`target table ${t} has no cell at row ${r}, column ${c}`);
        }
        const location = { index: at, tabId: targetTabId };
        for (const token of [...rows[r][c]].reverse()) {
          if (token.kind === 'text') {
            if (token.text) requests.push({ insertText: { location, text: token.text } });
          } else if (token.kind === 'chip') {
            requests.push({ insertRichLink: { location, richLinkProperties: { uri: token.uri } } });
          }
        }
      }
    }
  }
  return requests;
}

function assertParagraphCount(plan: SourcePlan, count: number): void {
  if (count !== plan.paragraphs.length) {
    throw new Error(`paragraph count mismatch: source ${plan.paragraphs.length}, target ${count}`);
  }
}

/** An API style object without the given fields (and without unset values). */
function withoutFields(
  style: object | null | undefined,
  drop: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style ?? {})) {
    if (value !== undefined && !drop.includes(key)) out[key] = value;
  }
  return out;
}

/**
 * Phase 3: per unit (one paragraph, or a run of consecutive bullet paragraphs
 * of one list in one container), in this order: paragraph style (incl.
 * namedStyleType) → bullet removal → text-style clear → run styles, per
 * paragraph; then createParagraphBullets over the unit. Units are emitted last
 * first, because createParagraphBullets removes the nesting tabs and shifts
 * every later index. Throws when the target's paragraph count differs.
 */
export function planStyles(plan: SourcePlan, targetTab: Tab, targetTabId: string): TabCopyRequest[] {
  const target = flatParagraphs(targetTab.documentTab?.body);
  assertParagraphCount(plan, target.length);
  const source = plan.paragraphs;
  const units: Array<{ start: number; requests: TabCopyRequest[] }> = [];
  let i = 0;
  while (i < source.length) {
    const head = source[i];
    let j = i;
    if (head.paragraph.bullet) {
      const listId = head.paragraph.bullet.listId;
      while (
        j + 1 < source.length &&
        sameContainer(source[j + 1].container, head.container) &&
        // A paragraph without a bullet never joins (an absent listId must not match one).
        Boolean(source[j + 1].paragraph.bullet) &&
        source[j + 1].paragraph.bullet?.listId === listId
      ) {
        j++;
      }
    }
    const requests: TabCopyRequest[] = [];
    for (let k = i; k <= j; k++) {
      const { paragraph, pieces } = source[k];
      const targetParagraph = target[k];
      const range = { startIndex: targetParagraph.startIndex, endIndex: targetParagraph.endIndex, tabId: targetTabId };
      const drop = paragraph.bullet ? [...PSTYLE_DROP, ...BULLET_INDENT_DROP] : PSTYLE_DROP;
      const paragraphStyle = withoutFields(paragraph.paragraphStyle, drop);
      if (hasKeys(paragraphStyle)) {
        requests.push({ updateParagraphStyle: { range, paragraphStyle, fields: Object.keys(paragraphStyle).join(',') } });
      }
      if (!paragraph.bullet && targetParagraph.paragraph.bullet) {
        requests.push({ deleteParagraphBullets: { range } });
      }
      requests.push({ updateTextStyle: { range, textStyle: {}, fields: ALL_TEXT_KEYS } });
      let cursor = targetParagraph.startIndex;
      for (const piece of pieces) {
        // Nesting tabs have a length but no style.
        const style = piece.style;
        if (hasKeys(style) && piece.length) {
          requests.push({
            updateTextStyle: {
              range: { startIndex: cursor, endIndex: cursor + piece.length, tabId: targetTabId },
              textStyle: style,
              fields: Object.keys(style).join(','),
            },
          });
        }
        cursor += piece.length;
      }
    }
    if (head.paragraph.bullet) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: target[i].startIndex, endIndex: target[j].endIndex, tabId: targetTabId },
          bulletPreset: presetFor(plan.lists[head.paragraph.bullet.listId ?? ''], plan.notes),
        },
      });
    }
    units.push({ start: target[i].startIndex, requests });
    i = j + 1;
  }
  return units
    .sort((a, b) => b.start - a.start)
    .flatMap((unit) => unit.requests);
}

/**
 * Phase 3b: createParagraphBullets resets indents and spacing, so re-apply each
 * bullet paragraph's source style, without namedStyleType (re-applying it
 * would wipe the run styles) and without headingId.
 */
export function planBulletParagraphStyles(plan: SourcePlan, targetTab: Tab, targetTabId: string): TabCopyRequest[] {
  const target = flatParagraphs(targetTab.documentTab?.body);
  assertParagraphCount(plan, target.length);
  const requests: TabCopyRequest[] = [];
  plan.paragraphs.forEach(({ paragraph }, k) => {
    if (!paragraph.bullet) return;
    const paragraphStyle = withoutFields(paragraph.paragraphStyle, [...PSTYLE_DROP, 'namedStyleType']);
    if (!hasKeys(paragraphStyle)) return;
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: target[k].startIndex, endIndex: target[k].endIndex, tabId: targetTabId },
        paragraphStyle,
        fields: Object.keys(paragraphStyle).join(','),
      },
    });
  });
  return requests;
}

/**
 * Phase 4: table column properties and cell styles (merges are not
 * reproduced, so rowSpan/columnSpan are dropped).
 */
export function planTableStyles(plan: SourcePlan, targetTab: Tab, targetTabId: string): TabCopyRequest[] {
  const targetTables = bodyTables(targetTab);
  if (targetTables.length !== plan.tables.length) {
    throw new Error(`table count mismatch: source ${plan.tables.length}, target ${targetTables.length}`);
  }
  const requests: TabCopyRequest[] = [];
  plan.tables.forEach((table, t) => {
    const tableStartLocation = { index: targetTables[t].startIndex ?? 0, tabId: targetTabId };
    (table.tableStyle?.tableColumnProperties ?? []).forEach((properties, columnIndex) => {
      const tableColumnProperties = withoutFields(properties, []);
      if (!hasKeys(tableColumnProperties)) return;
      requests.push({
        updateTableColumnProperties: {
          tableStartLocation,
          columnIndices: [columnIndex],
          tableColumnProperties,
          fields: Object.keys(tableColumnProperties).join(','),
        },
      });
    });
    (table.tableRows ?? []).forEach((row, rowIndex) => {
      (row.tableCells ?? []).forEach((cell, columnIndex) => {
        const tableCellStyle = withoutFields(cell.tableCellStyle, ['rowSpan', 'columnSpan']);
        if (!hasKeys(tableCellStyle)) return;
        requests.push({
          updateTableCellStyle: {
            tableRange: {
              tableCellLocation: { tableStartLocation, rowIndex, columnIndex },
              rowSpan: 1,
              columnSpan: 1,
            },
            tableCellStyle,
            fields: Object.keys(tableCellStyle).join(','),
          },
        });
      });
    });
  });
  return requests;
}

// Sentinels for non-text elements in verification text (control characters
// never occur in Docs text, so they cannot collide with real content).
const CHIP_MARK = '\u0001chip\u0001';
const PAGE_BREAK_MARK = '\u0001pagebreak\u0001';

function expectedText(pieces: Piece[]): string {
  return pieces
    .map((piece) => {
      if (piece.kind === 'chip') return CHIP_MARK;
      if (piece.kind === 'pagebreak') return PAGE_BREAK_MARK;
      return piece.nesting ? '' : piece.text;
    })
    .join('');
}

function actualText(paragraph: Paragraph): string {
  return (paragraph.elements ?? [])
    .map((element) => {
      if (element.textRun) return element.textRun.content ?? '';
      if (element.richLink) return CHIP_MARK;
      if (element.pageBreak) return PAGE_BREAK_MARK;
      return `\u0001${elementKind(element)}\u0001`;
    })
    .join('');
}

/**
 * Paragraph-format fields compared by verification, when set on the source
 * paragraph. headingId is never compared. If the live API normalises one of
 * these on every paragraph (a difference that is not a copy defect), remove
 * that field here with a comment saying why.
 */
export const VERIFIED_PARAGRAPH_FIELDS = [
  'alignment',
  'direction',
  'indentStart',
  'indentEnd',
  'indentFirstLine',
  'spaceAbove',
  'spaceBelow',
  'lineSpacing',
  'spacingMode',
] as const;
const DIMENSION_FIELDS = new Set(['indentStart', 'indentEnd', 'indentFirstLine', 'spaceAbove', 'spaceBelow']);

/**
 * A paragraph-style field as it takes effect: the paragraph's own value, else
 * its named style's, else (for lengths) 0. Lengths compare by magnitude.
 */
function effectiveParagraphValue(
  style: docs_v1.Schema$ParagraphStyle | undefined,
  namedStyles: docs_v1.Schema$NamedStyles | undefined,
  field: (typeof VERIFIED_PARAGRAPH_FIELDS)[number]
): unknown {
  let value: unknown = style?.[field];
  if (value === undefined || value === null) {
    const type = style?.namedStyleType ?? 'NORMAL_TEXT';
    value = namedStyles?.styles?.find((named) => named.namedStyleType === type)?.paragraphStyle?.[field];
  }
  if (DIMENSION_FIELDS.has(field)) {
    return (value as docs_v1.Schema$Dimension | undefined | null)?.magnitude ?? 0;
  }
  return value ?? undefined;
}

/**
 * Compare the copied tab with the source: per paragraph the text (with chip
 * fallbacks, people and dates as the text that was inserted), named style,
 * paragraph formatting, bullet and nesting; list grouping (one-to-one list
 * mapping); table count and shapes. Run styles and table cell styles are not
 * compared. Reports indices and kinds only, never document text.
 */
export function verifyCopy(plan: SourcePlan, sourceTab: Tab, targetTab: Tab): CopyVerification {
  const mismatches: CopyMismatch[] = [];
  const target = flatParagraphs(targetTab.documentTab?.body);
  const sourceNamed = sourceTab.documentTab?.namedStyles;
  const targetNamed = targetTab.documentTab?.namedStyles;
  if (target.length !== plan.paragraphs.length) {
    mismatches.push({ kind: 'paragraphCount' });
  }

  const sourceToTarget = new Map<string, string>();
  const targetToSource = new Map<string, string>();
  const count = Math.min(target.length, plan.paragraphs.length);
  for (let k = 0; k < count; k++) {
    const { paragraph: src, pieces } = plan.paragraphs[k];
    const tgt = target[k].paragraph;
    if (expectedText(pieces) !== actualText(tgt)) {
      mismatches.push({ paragraphIndex: k, kind: 'text' });
    }
    const srcType = src.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
    const tgtType = tgt.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
    if (srcType !== tgtType) {
      mismatches.push({ paragraphIndex: k, kind: 'namedStyle' });
    }
    for (const field of VERIFIED_PARAGRAPH_FIELDS) {
      const own = src.paragraphStyle?.[field];
      if (own === undefined || own === null) continue;
      const expected = effectiveParagraphValue(src.paragraphStyle, sourceNamed, field);
      const actual = effectiveParagraphValue(tgt.paragraphStyle, targetNamed, field);
      if (!deepEqual(expected, actual)) {
        mismatches.push({ paragraphIndex: k, kind: `paragraphStyle.${field}` });
      }
    }
    if (Boolean(src.bullet) !== Boolean(tgt.bullet) || (src.bullet?.nestingLevel ?? 0) !== (tgt.bullet?.nestingLevel ?? 0)) {
      mismatches.push({ paragraphIndex: k, kind: 'bullet' });
    } else if (src.bullet && tgt.bullet) {
      const srcList = src.bullet.listId ?? '';
      const tgtList = tgt.bullet.listId ?? '';
      const mapped = sourceToTarget.get(srcList);
      const back = targetToSource.get(tgtList);
      if ((mapped !== undefined && mapped !== tgtList) || (back !== undefined && back !== srcList)) {
        mismatches.push({ paragraphIndex: k, kind: 'listGrouping' });
      } else {
        sourceToTarget.set(srcList, tgtList);
        targetToSource.set(tgtList, srcList);
      }
    }
  }

  const targetTables = bodyTables(targetTab);
  plan.tables.forEach((table, t) => {
    const other = targetTables[t]?.table;
    if (!other || other.rows !== table.rows || other.columns !== table.columns) {
      mismatches.push({ tableIndex: t, kind: 'tableShape' });
    }
  });
  if (targetTables.length > plan.tables.length) {
    mismatches.push({ tableIndex: plan.tables.length, kind: 'tableShape' });
  }

  return {
    passed: mismatches.length === 0,
    checkedParagraphs: plan.paragraphs.length,
    tables: plan.tables.length,
    lists: new Set(plan.paragraphs.flatMap((p) => (p.paragraph.bullet ? [p.paragraph.bullet.listId ?? ''] : []))).size,
    placeholders: plan.placeholders,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 5),
  };
}

/**
 * Run the copy: read and plan the source, check every chip, prepare the
 * target, then Phases 0-4 and a verification read. Requests are sent in
 * chunks of CHUNK per batchUpdate. Any failure is rethrown as a TabCopyError
 * naming the phase and whether content had already been written.
 */
export async function copyTabContent(deps: TabCopyDeps): Promise<TabCopyResult> {
  let phase = 'read source';
  let wroteContent = false;
  let attemptedWrite = false;
  let requests = 0;
  let rounds = 0;

  const send = async (label: string, batch: TabCopyRequest[]): Promise<void> => {
    phase = label;
    if (batch.length === 0) return;
    for (let i = 0; i < batch.length; i += CHUNK) {
      attemptedWrite = true;
      await deps.batchUpdate(batch.slice(i, i + CHUNK));
      wroteContent = true;
    }
    requests += batch.length;
    rounds++;
  };

  try {
    const source = await deps.getSourceTab();

    phase = 'check smart chips';
    const chipAccess = new Map<string, boolean>();
    for (const uri of collectChipUris(source)) {
      chipAccess.set(uri, idFromUri(uri) ? await deps.checkChip(uri) : false);
    }
    phase = 'plan source';
    const plan = buildSourcePlan(source, chipAccess);

    phase = 'prepare target';
    const targetTabId = await deps.prepareTarget();

    phase = 'read target';
    let target = await deps.getTab(targetTabId);

    // Phase 0: clear target body, reset its last paragraph, copy doc + named styles
    const clear = planClear(source, target, targetTabId);
    await send('clear + document styles', clear.requests);

    // Phase 1: skeleton appended in order
    await send('skeleton', planSkeleton(plan, targetTabId));

    // Phase 2: table cells, reverse order
    phase = 'table cells';
    target = await deps.getTab(targetTabId);
    await send('table cells', planTableCells(plan, target, targetTabId));

    // Phase 3: per unit (descending): named/para style -> clear text style -> run styles -> bullets
    phase = 'styles + bullets';
    target = await deps.getTab(targetTabId);
    await send('styles + bullets', planStyles(plan, target, targetTabId));

    // Phase 3b: bullets reset paragraph style; re-apply it minus namedStyleType (re-applying that wipes run styles)
    phase = 'bullet paragraph styles';
    target = await deps.getTab(targetTabId);
    await send('bullet paragraph styles', planBulletParagraphStyles(plan, target, targetTabId));

    // Phase 4: tables (from the Phase 3b read; 3b changes no indices)
    phase = 'table styles';
    await send('table styles', planTableStyles(plan, target, targetTabId));

    phase = 'verify';
    const final = await deps.getTab(targetTabId);
    const verification = verifyCopy(plan, source, final);

    return {
      targetTabId,
      requests,
      rounds,
      chipsCopied: plan.chipsCopied,
      chipFallbacks: plan.chipFallbacks,
      convertedToText: plan.convertedToText,
      namedStylesCopied: clear.namedStylesCopied,
      notCopied: plan.notCopied,
      notes: [...new Set(plan.notes)].sort(),
      verification,
    };
  } catch (error) {
    throw new TabCopyError(phase, wroteContent, attemptedWrite, error);
  }
}
