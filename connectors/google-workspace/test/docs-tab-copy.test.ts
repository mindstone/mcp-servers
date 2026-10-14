import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { ALL_TEXT_KEYS, DocsInputError } from '../src/modules/docs/tabs.js';
import {
  CHUNK,
  TabCopyError,
  buildSourcePlan,
  collectChipUris,
  copyTabContent,
  idFromUri,
  planBulletParagraphStyles,
  planClear,
  planSkeleton,
  planStyles,
  planTableCells,
  planTableStyles,
  presetFor,
  verifyCopy,
  type TabCopyDeps,
  type TabCopyRequest,
} from '../src/modules/docs/tabCopy.js';

type Tab = docs_v1.Schema$Tab;

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/docs-tabs/copy-doc.json');
const OK_URI = 'https://docs.google.com/document/d/AcmeFictionalDoc000000000000/edit';
const NO_URI = 'https://docs.google.com/spreadsheets/d/AcmeFictionalSheet00000000000/edit';
const ACCESS = new Map([[OK_URI, true], [NO_URI, false]]);
const pt = (magnitude: number) => ({ magnitude, unit: 'PT' });

function loadDoc(): docs_v1.Schema$Document {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as docs_v1.Schema$Document;
}

function tabOf(doc: docs_v1.Schema$Document, tabId: string): Tab {
  const tab = doc.tabs?.find((t) => t.tabProperties?.tabId === tabId);
  if (!tab) throw new Error(`fixture has no tab ${tabId}`);
  return tab;
}

const live = (): Tab => tabOf(loadDoc(), 't.live');
const dst = { tabId: 't.dst' };

/**
 * What a faithful copy of the live tab looks like when read back: inaccessible
 * chips, people and dates as text, the image as its placeholder, no table of
 * contents, and new list ids.
 */
function copiedLike(source: Tab): Tab {
  const tab = structuredClone(source);
  const fix = (paragraph: docs_v1.Schema$Paragraph): void => {
    paragraph.elements = (paragraph.elements ?? []).map((element) => {
      const link = element.richLink?.richLinkProperties;
      if (link && !ACCESS.get(link.uri ?? '')) return { textRun: { content: link.title ?? '' } };
      if (element.person) return { textRun: { content: element.person.personProperties?.name ?? '' } };
      if (element.dateElement) return { textRun: { content: element.dateElement.dateElementProperties?.displayText ?? '' } };
      if (element.inlineObjectElement) return { textRun: { content: '[inlineObjectElement]' } };
      return element;
    });
    if (paragraph.bullet) paragraph.bullet = { ...paragraph.bullet, listId: `copy-${paragraph.bullet.listId}` };
  };
  const body = tab.documentTab!.body!;
  body.content = body.content!.filter((element) => !element.tableOfContents);
  for (const element of body.content) {
    if (element.paragraph) fix(element.paragraph);
    for (const row of element.table?.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) for (const c of cell.content ?? []) if (c.paragraph) fix(c.paragraph);
    }
  }
  return tab;
}

function bodyParagraph(tab: Tab, n: number): docs_v1.Schema$Paragraph {
  return tab.documentTab!.body!.content!.filter((element) => element.paragraph)[n].paragraph!;
}

describe('presetFor', () => {
  it.each([
    [{ glyphType: 'DECIMAL' }, 'NUMBERED_DECIMAL_ALPHA_ROMAN'],
    [{ glyphType: 'ZERO_DECIMAL' }, 'NUMBERED_DECIMAL_ALPHA_ROMAN'],
    [{ glyphType: 'ALPHA' }, 'NUMBERED_UPPERALPHA_ALPHA_ROMAN'],
    [{ glyphType: 'UPPER_ALPHA' }, 'NUMBERED_UPPERALPHA_ALPHA_ROMAN'],
    [{ glyphSymbol: '●' }, 'BULLET_DISC_CIRCLE_SQUARE'],
    [{ glyphSymbol: '○' }, 'BULLET_DISC_CIRCLE_SQUARE'],
    [{ glyphSymbol: '■' }, 'BULLET_DISC_CIRCLE_SQUARE'],
    [{ glyphType: 'GLYPH_TYPE_UNSPECIFIED' }, 'BULLET_DISC_CIRCLE_SQUARE'],
    [{}, 'BULLET_DISC_CIRCLE_SQUARE'],
  ])('maps %j to %s without a note', (level, preset) => {
    const notes: string[] = [];
    expect(presetFor({ listProperties: { nestingLevels: [level] } }, notes)).toBe(preset);
    expect(notes).toEqual([]);
  });

  it('maps an unknown symbol or an unsupported numbering to discs, with a note', () => {
    const notes: string[] = [];
    expect(presetFor({ listProperties: { nestingLevels: [{ glyphSymbol: '★' }] } }, notes)).toBe('BULLET_DISC_CIRCLE_SQUARE');
    expect(presetFor({ listProperties: { nestingLevels: [{ glyphType: 'ROMAN' }] } }, notes)).toBe('BULLET_DISC_CIRCLE_SQUARE');
    expect(notes).toEqual(['unmapped glyph none/★', 'numbered list style ROMAN copied as bullets']);
  });
});

describe('source plan', () => {
  it('idFromUri reads a Drive file id and returns null for other links', () => {
    expect(idFromUri(OK_URI)).toBe('AcmeFictionalDoc000000000000');
    expect(idFromUri('https://example.com/plan')).toBeNull();
  });

  it('collects every chip URI once, body and table cells, in document order', () => {
    expect(collectChipUris(live())).toEqual([NO_URI, OK_URI]);
  });

  it('builds the skeleton tokens: newline before a table and the final newline stripped, nesting tabs, chips, page break, placeholder', () => {
    const plan = buildSourcePlan(live(), ACCESS);
    expect(plan.bodyTokens).toEqual([
      { kind: 'text', text: '10/13/2031\nOwner: Jane see plan\nFirst item\n\tNested item\nStep one\nStep two 🎉 done\nBefore table' },
      { kind: 'table', rows: 2, columns: 2 },
      { kind: 'text', text: 'Links: ' },
      { kind: 'chip', uri: OK_URI },
      { kind: 'text', text: ' and Budget sheet on Oct 20, 2031\n' },
      { kind: 'pagebreak' },
      { kind: 'text', text: '[inlineObjectElement]\nEnd' },
    ]);
    expect(plan.cellTokens).toEqual([[
      [[{ kind: 'text', text: 'Name' }], [{ kind: 'text', text: 'Spend' }]],
      [[{ kind: 'text', text: 'Jane Example' }], [{ kind: 'text', text: 'Budget sheet' }]],
    ]]);
    expect(plan.paragraphs).toHaveLength(15);
    expect(plan.notes).toEqual([]);
  });

  it('records a chip fallback once even when the chip also sits in a table cell, and counts copied chips', () => {
    const plan = buildSourcePlan(live(), ACCESS);
    expect(plan.chipFallbacks).toEqual([{ uri: NO_URI, title: 'Budget sheet' }]);
    expect(plan.chipsCopied).toBe(1);
    const fallbackPiece = plan.paragraphs[11].pieces.find((piece) => piece.kind === 'text' && piece.text === 'Budget sheet');
    expect(fallbackPiece).toMatchObject({ style: { link: { url: NO_URI } } });
  });

  it('turns a person into its name with a mailto link and a date into its display text', () => {
    const plan = buildSourcePlan(live(), ACCESS);
    expect(plan.paragraphs[9].pieces[0]).toEqual({
      kind: 'text',
      text: 'Jane Example',
      length: 12,
      style: { link: { url: 'mailto:jane@example.com' } },
    });
    expect(plan.paragraphs[11].pieces.some((piece) => piece.kind === 'text' && piece.text === 'Oct 20, 2031')).toBe(true);
    expect(plan.convertedToText).toEqual({ people: 1, dates: 1 });
  });

  it('reports a table of contents and an image as not copied, and the image as a placeholder', () => {
    const plan = buildSourcePlan(live(), ACCESS);
    expect(plan.notCopied).toEqual({ inlineObjectElement: 1, tableOfContents: 1 });
    expect(plan.placeholders).toBe(1);
  });

  it('notes a table without a preceding newline and reports merged cells', () => {
    const source: Tab = {
      documentTab: {
        body: {
          content: [
            { table: { rows: 1, columns: 2, tableRows: [{ tableCells: [
              { content: [{ paragraph: { elements: [{ textRun: { content: 'a\n' } }] } }], tableCellStyle: { columnSpan: 2 } },
              { content: [{ paragraph: { elements: [{ textRun: { content: '\n' } }] } }] },
            ] }] } },
            { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
          ],
        },
      },
    };
    const plan = buildSourcePlan(source, new Map());
    expect(plan.notes).toEqual(['table without preceding newline']);
    expect(plan.notCopied).toEqual({ 'merged table cells': 1 });
  });

  it('counts a floating image as not copied without a placeholder, and the copy still verifies', () => {
    const source = live();
    bodyParagraph(source, 1).positionedObjectIds = ['kix.float1'];
    const plan = buildSourcePlan(source, ACCESS);
    expect(plan.notCopied).toEqual({ inlineObjectElement: 1, tableOfContents: 1, positionedObject: 1 });
    expect(plan.placeholders).toBe(1);
    expect(verifyCopy(plan, source, copiedLike(source)).passed).toBe(true);
  });

  it('refuses a table whose rows have fewer cells than its columns (a spanning cell)', () => {
    const source: Tab = {
      documentTab: {
        body: {
          content: [
            { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
            { table: { rows: 1, columns: 2, tableRows: [{ tableCells: [
              { content: [{ paragraph: { elements: [{ textRun: { content: 'a\n' } }] } }], tableCellStyle: { columnSpan: 2 } },
            ] }] } },
          ],
        },
      },
    };
    expect(() => buildSourcePlan(source, new Map())).toThrow(DocsInputError);
    expect(() => buildSourcePlan(source, new Map())).toThrow(
      "This tab has a table with merged cells in a shape that can't be copied. Nothing was written."
    );
  });
});

describe('planners', () => {
  it('planClear clears an existing target, resets [1,2), copies page setup and differing named styles', () => {
    const doc = loadDoc();
    const { requests, namedStylesCopied } = planClear(tabOf(doc, 't.live'), tabOf(doc, 't.old'), 't.old');
    const range = { startIndex: 1, endIndex: 2, tabId: 't.old' };
    expect(requests.slice(0, 4)).toEqual([
      { deleteContentRange: { range: { startIndex: 1, endIndex: 18, tabId: 't.old' } } },
      { deleteParagraphBullets: { range } },
      { updateParagraphStyle: { range, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
      { updateTextStyle: { range, textStyle: {}, fields: ALL_TEXT_KEYS } },
    ]);
    expect(requests[4]).toEqual({
      updateDocumentStyle: {
        tabId: 't.old',
        documentStyle: { marginTop: pt(72), marginBottom: pt(72), marginLeft: pt(72), marginRight: pt(72), pageSize: { width: pt(612), height: pt(792) } },
        fields: 'marginTop,marginBottom,marginLeft,marginRight,pageSize',
      },
    });
    expect(JSON.stringify(requests)).not.toContain('useCustomHeaderFooterMargins');
    const heading1 = tabOf(doc, 't.live').documentTab!.namedStyles!.styles![1];
    expect(requests.slice(5)).toEqual([
      { updateNamedStyle: { tabId: 't.old', namedStyle: heading1, fields: 'namedStyleType,textStyle,paragraphStyle' } },
    ]);
    expect(namedStylesCopied).toBe(1);
  });

  it('planClear on an empty new tab sends no delete, and no updateDocumentStyle when the source has none of the keys', () => {
    const source: Tab = { documentTab: { documentStyle: { useCustomHeaderFooterMargins: true }, body: { content: [] } } };
    const target: Tab = { documentTab: { body: { content: [
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      { startIndex: 1, endIndex: 2, paragraph: { elements: [{ textRun: { content: '\n' } }] } },
    ] } } };
    const { requests, namedStylesCopied } = planClear(source, target, 't.new');
    expect(requests.map((request) => Object.keys(request)[0])).toEqual([
      'deleteParagraphBullets',
      'updateParagraphStyle',
      'updateTextStyle',
    ]);
    expect(namedStylesCopied).toBe(0);
  });

  it('planSkeleton appends tokens in order with no newline before the table and no empty insertText', () => {
    const plan = buildSourcePlan(live(), ACCESS);
    const eos = { endOfSegmentLocation: dst };
    expect(planSkeleton(plan, 't.dst')).toEqual([
      { insertText: { ...eos, text: '10/13/2031\nOwner: Jane see plan\nFirst item\n\tNested item\nStep one\nStep two 🎉 done\nBefore table' } },
      { insertTable: { ...eos, rows: 2, columns: 2 } },
      { insertText: { ...eos, text: 'Links: ' } },
      { insertRichLink: { ...eos, richLinkProperties: { uri: OK_URI } } },
      { insertText: { ...eos, text: ' and Budget sheet on Oct 20, 2031\n' } },
      { insertPageBreak: eos },
      { insertText: { ...eos, text: '[inlineObjectElement]\nEnd' } },
    ]);
  });

  it('planSkeleton sends no insertText for an empty text token', () => {
    const plan = {
      ...buildSourcePlan(live(), ACCESS),
      bodyTokens: [{ kind: 'text' as const, text: '' }, { kind: 'pagebreak' as const }, { kind: 'text' as const, text: 'End' }],
    };
    expect(planSkeleton(plan, 't.dst')).toEqual([
      { insertPageBreak: { endOfSegmentLocation: dst } },
      { insertText: { endOfSegmentLocation: dst, text: 'End' } },
    ]);
  });

  it('planTableCells fills the last table first and a text-chip-text cell in reverse token order', () => {
    const cell = (content: docs_v1.Schema$ParagraphElement[]) => ({ content: [{ paragraph: { elements: content } }] });
    const source: Tab = { documentTab: { body: { content: [
      { paragraph: { elements: [{ textRun: { content: 'Intro\n' } }] } },
      { table: { rows: 1, columns: 1, tableRows: [{ tableCells: [cell([{ textRun: { content: 'A\n' } }])] }] } },
      { paragraph: { elements: [{ textRun: { content: 'Mid\n' } }] } },
      { table: { rows: 1, columns: 2, tableRows: [{ tableCells: [
        cell([{ textRun: { content: 'x\n' } }]),
        cell([
          { textRun: { content: 'Due ' } },
          { richLink: { richLinkProperties: { uri: OK_URI, title: 'Acme plan' } } },
          { textRun: { content: ' now\n' } },
        ]),
      ] }] } },
      { paragraph: { elements: [{ textRun: { content: 'End\n' } }] } },
    ] } } };
    const emptyCell = (startIndex: number) => ({ content: [{ startIndex, paragraph: {} }] });
    const target: Tab = { documentTab: { body: { content: [
      { table: { tableRows: [{ tableCells: [emptyCell(10)] }] } },
      { table: { tableRows: [{ tableCells: [emptyCell(20), emptyCell(22)] }] } },
    ] } } };
    const location = (index: number) => ({ index, tabId: 't.dst' });
    expect(planTableCells(buildSourcePlan(source, ACCESS), target, 't.dst')).toEqual([
      { insertText: { location: location(22), text: ' now' } },
      { insertRichLink: { location: location(22), richLinkProperties: { uri: OK_URI } } },
      { insertText: { location: location(22), text: 'Due ' } },
      { insertText: { location: location(20), text: 'x' } },
      { insertText: { location: location(10), text: 'A' } },
    ]);
  });

  it('planTableCells fills cells last table / row / column first, at each cell\'s first index', () => {
    const plan = buildSourcePlan(live(), ACCESS);
    const at = (index: number, text: string) => ({ insertText: { location: { index, tabId: 't.dst' }, text } });
    expect(planTableCells(plan, live(), 't.dst')).toEqual([
      at(115, 'Budget sheet'),
      at(112, 'Jane Example'),
      at(104, 'Spend'),
      at(98, 'Name'),
    ]);
  });

  it('planStyles emits units last-first; inside a unit: paragraph style, bullet removal, clear, runs, then bullets', () => {
    const plan = buildSourcePlan(live(), ACCESS);
    const target = copiedLike(live());
    // The target's "Before table" paragraph carries a stray bullet the source doesn't have.
    bodyParagraph(target, 6).bullet = { listId: 'kix.stray' };
    const requests = planStyles(plan, target, 't.dst');

    const starts = requests
      .filter((request) => request.updateParagraphStyle)
      .map((request) => request.updateParagraphStyle!.range!.startIndex);
    expect(starts).toEqual([150, 139, 137, 117, 115, 112, 104, 98, 82, 56, 65, 33, 44, 12, 1]);

    const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex, tabId: 't.dst' });
    const clear = (startIndex: number, endIndex: number) => ({ updateTextStyle: { range: range(startIndex, endIndex), textStyle: {}, fields: ALL_TEXT_KEYS } });
    const bulletStyle = { namedStyleType: 'NORMAL_TEXT', spaceAbove: pt(4), spaceBelow: pt(2) };
    const unitStart = requests.findIndex((request) => request.updateParagraphStyle?.range?.startIndex === 33);
    expect(requests.slice(unitStart, unitStart + 7)).toEqual([
      { updateParagraphStyle: { range: range(33, 44), paragraphStyle: bulletStyle, fields: 'namedStyleType,spaceAbove,spaceBelow' } },
      clear(33, 44),
      { updateParagraphStyle: { range: range(44, 56), paragraphStyle: bulletStyle, fields: 'namedStyleType,spaceAbove,spaceBelow' } },
      clear(44, 56),
      // One nesting tab precedes the italic run.
      { updateTextStyle: { range: range(45, 57), textStyle: { italic: true }, fields: 'italic' } },
      { createParagraphBullets: { range: range(33, 56), bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
      { updateParagraphStyle: { range: range(12, 33), paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
    ]);

    const strayStart = requests.findIndex((request) => request.updateParagraphStyle?.range?.startIndex === 82);
    expect(requests.slice(strayStart, strayStart + 3).map((request) => Object.keys(request)[0])).toEqual([
      'updateParagraphStyle',
      'deleteParagraphBullets',
      'updateTextStyle',
    ]);
    expect(requests).toContainEqual({ createParagraphBullets: { range: range(56, 82), bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' } });
    // The heading drops headingId but keeps its other paragraph fields.
    expect(requests).toContainEqual({
      updateParagraphStyle: { range: range(1, 12), paragraphStyle: { namedStyleType: 'HEADING_1', alignment: 'CENTER' }, fields: 'namedStyleType,alignment' },
    });
  });

  it('planStyles places run styles after a non-BMP character by UTF-16 units', () => {
    const plan = buildSourcePlan(live(), ACCESS);
    const requests = planStyles(plan, copiedLike(live()), 't.dst');
    // "Step two 🎉 " is 12 UTF-16 units (the emoji is 2), so "done" starts at 65 + 12.
    expect(requests).toContainEqual({ updateTextStyle: { range: { startIndex: 77, endIndex: 81, tabId: 't.dst' }, textStyle: { bold: true }, fields: 'bold' } });
    // Bullet paragraphs leave out their indents in Phase 3.
    const stepTwo = requests.find((request) => request.updateParagraphStyle?.range?.startIndex === 65);
    expect(stepTwo?.updateParagraphStyle?.paragraphStyle).toEqual({ namedStyleType: 'NORMAL_TEXT' });
  });

  it('planStyles never joins a paragraph without a bullet to a bullet unit whose list id is missing', () => {
    const para = (startIndex: number, content: string, bullet?: docs_v1.Schema$Bullet): docs_v1.Schema$StructuralElement => ({
      startIndex,
      endIndex: startIndex + content.length,
      paragraph: { elements: [{ startIndex, endIndex: startIndex + content.length, textRun: { content } }], ...(bullet ? { bullet } : {}) },
    });
    const source: Tab = { documentTab: { body: { content: [para(1, 'One\n', {}), para(5, 'Two\n')] } } };
    const requests = planStyles(buildSourcePlan(source, new Map()), structuredClone(source), 't.dst');
    expect(requests.filter((request) => request.createParagraphBullets)).toEqual([
      { createParagraphBullets: { range: { startIndex: 1, endIndex: 5, tabId: 't.dst' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
    ]);
  });

  it('planStyles throws when the target paragraph count differs', () => {
    const plan = buildSourcePlan(live(), ACCESS);
    const target = copiedLike(live());
    target.documentTab!.body!.content!.pop();
    expect(() => planStyles(plan, target, 't.dst')).toThrow('paragraph count mismatch: source 15, target 14');
  });

  it('planBulletParagraphStyles re-applies bullet indents and spacing exactly, without namedStyleType or headingId', () => {
    const plan = buildSourcePlan(live(), ACCESS);
    const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex, tabId: 't.dst' });
    expect(planBulletParagraphStyles(plan, copiedLike(live()), 't.dst')).toEqual([
      { updateParagraphStyle: { range: range(33, 44), paragraphStyle: { indentStart: pt(36), indentFirstLine: pt(18), spaceAbove: pt(4), spaceBelow: pt(2) }, fields: 'indentStart,indentFirstLine,spaceAbove,spaceBelow' } },
      { updateParagraphStyle: { range: range(44, 56), paragraphStyle: { indentStart: pt(72), indentFirstLine: pt(54), spaceAbove: pt(4), spaceBelow: pt(2) }, fields: 'indentStart,indentFirstLine,spaceAbove,spaceBelow' } },
      { updateParagraphStyle: { range: range(56, 65), paragraphStyle: { indentStart: pt(36), indentFirstLine: pt(18) }, fields: 'indentStart,indentFirstLine' } },
      { updateParagraphStyle: { range: range(65, 82), paragraphStyle: { indentStart: pt(36), indentFirstLine: pt(18) }, fields: 'indentStart,indentFirstLine' } },
    ]);
  });

  it('planTableStyles copies column properties and cell styles, without row or column spans', () => {
    const plan = buildSourcePlan(live(), ACCESS);
    const tableStartLocation = { index: 95, tabId: 't.dst' };
    expect(planTableStyles(plan, copiedLike(live()), 't.dst')).toEqual([
      { updateTableColumnProperties: { tableStartLocation, columnIndices: [0], tableColumnProperties: { widthType: 'FIXED_WIDTH', width: pt(100) }, fields: 'widthType,width' } },
      { updateTableColumnProperties: { tableStartLocation, columnIndices: [1], tableColumnProperties: { widthType: 'EVENLY_DISTRIBUTED' }, fields: 'widthType' } },
      {
        updateTableCellStyle: {
          tableRange: { tableCellLocation: { tableStartLocation, rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: 1 },
          tableCellStyle: { backgroundColor: { color: { rgbColor: { red: 0.9, green: 0.9, blue: 0.9 } } } },
          fields: 'backgroundColor',
        },
      },
    ]);
  });
});

describe('verifyCopy', () => {
  it('passes on a faithful copy and counts paragraphs, tables, lists and placeholders', () => {
    const source = live();
    const plan = buildSourcePlan(source, ACCESS);
    expect(verifyCopy(plan, source, copiedLike(source))).toEqual({
      passed: true,
      checkedParagraphs: 15,
      tables: 1,
      lists: 2,
      placeholders: 1,
      mismatchCount: 0,
      mismatches: [],
    });
  });

  it('treats an absent zero indent and a value from the named style as equal', () => {
    const source = live();
    bodyParagraph(source, 6).paragraphStyle = { namedStyleType: 'NORMAL_TEXT', indentStart: pt(0), lineSpacing: 115 };
    const plan = buildSourcePlan(source, ACCESS);
    // The copy has neither field set: indent 0 by default, line spacing from NORMAL_TEXT (115).
    expect(verifyCopy(plan, source, copiedLike(live())).passed).toBe(true);
  });

  it('reports a list-grouping mismatch, a bullet indent difference and a text difference by index and kind', () => {
    const source = live();
    const plan = buildSourcePlan(source, ACCESS);
    const target = copiedLike(source);
    bodyParagraph(target, 3).bullet!.listId = 'kix.other';
    bodyParagraph(target, 2).paragraphStyle!.indentStart = pt(18);
    bodyParagraph(target, 1).elements![0].textRun!.content = 'Owner? ';
    const result = verifyCopy(plan, source, target);
    expect(result.passed).toBe(false);
    expect(result.mismatches).toEqual([
      { paragraphIndex: 1, kind: 'text' },
      { paragraphIndex: 2, kind: 'paragraphStyle.indentStart' },
      { paragraphIndex: 3, kind: 'listGrouping' },
    ]);
  });

  it('reports a bullet, named-style and table-shape difference', () => {
    const source = live();
    const plan = buildSourcePlan(source, ACCESS);
    const target = copiedLike(source);
    delete bodyParagraph(target, 4).bullet;
    bodyParagraph(target, 0).paragraphStyle!.namedStyleType = 'NORMAL_TEXT';
    target.documentTab!.body!.content!.find((element) => element.table)!.table!.columns = 3;
    expect(verifyCopy(plan, source, target).mismatches).toEqual([
      { paragraphIndex: 0, kind: 'namedStyle' },
      { paragraphIndex: 4, kind: 'bullet' },
      { tableIndex: 0, kind: 'tableShape' },
    ]);
  });
});

type FakeOptions = {
  target?: (read: number) => Tab;
  failOnBatch?: number;
  chipError?: Error;
};

function fakeDeps(source: Tab, options: FakeOptions = {}) {
  const log: string[] = [];
  const batches: TabCopyRequest[][] = [];
  let reads = 0;
  const deps: TabCopyDeps = {
    getSourceTab: async () => {
      log.push('getSourceTab');
      return structuredClone(source);
    },
    getTab: async (tabId) => {
      reads++;
      log.push(`getTab ${tabId}`);
      return options.target ? options.target(reads) : copiedLike(source);
    },
    batchUpdate: async (requests) => {
      batches.push(requests);
      log.push(`batchUpdate ${requests.length}`);
      if (options.failOnBatch === batches.length) throw new Error('Internal error encountered.');
    },
    checkChip: async (uri) => {
      log.push(`checkChip ${idFromUri(uri)}`);
      if (options.chipError) throw options.chipError;
      return ACCESS.get(uri) ?? false;
    },
    prepareTarget: async () => {
      log.push('prepareTarget');
      return 't.dst';
    },
  };
  return { deps, log, batches };
}

describe('copyTabContent', () => {
  it('checks every chip before preparing the target or writing anything, then reports the copy', async () => {
    const { deps, log } = fakeDeps(live());
    const result = await copyTabContent(deps);
    expect(log.slice(0, 5)).toEqual([
      'getSourceTab',
      'checkChip AcmeFictionalSheet00000000000',
      'checkChip AcmeFictionalDoc000000000000',
      'prepareTarget',
      'getTab t.dst',
    ]);
    expect(log.indexOf('prepareTarget')).toBeLessThan(log.findIndex((entry) => entry.startsWith('batchUpdate')));
    expect(result).toMatchObject({
      targetTabId: 't.dst',
      chipsCopied: 1,
      chipFallbacks: [{ uri: NO_URI, title: 'Budget sheet' }],
      convertedToText: { people: 1, dates: 1 },
      notCopied: { inlineObjectElement: 1, tableOfContents: 1 },
      verification: { passed: true },
    });
    expect(result.rounds).toBe(6);
  });

  it(`sends at most ${CHUNK} requests per batchUpdate`, async () => {
    const content: docs_v1.Schema$StructuralElement[] = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];
    let index = 1;
    for (let n = 0; n < 120; n++) {
      // "Line" (bold) + " nn\n": three Phase 3 requests per paragraph.
      const text = ` ${String(n).padStart(3, '0')}\n`;
      content.push({
        startIndex: index,
        endIndex: index + 4 + text.length,
        paragraph: {
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          elements: [
            { startIndex: index, endIndex: index + 4, textRun: { content: 'Line', textStyle: { bold: true } } },
            { startIndex: index + 4, endIndex: index + 4 + text.length, textRun: { content: text, textStyle: {} } },
          ],
        },
      });
      index += 4 + text.length;
    }
    const source: Tab = { documentTab: { body: { content } } };
    const { deps, batches } = fakeDeps(source, { target: () => structuredClone(source) });
    const result = await copyTabContent(deps);
    // Phase 0 (delete + reset), Phase 1 (one insertText), Phase 3 (360 requests in three chunks).
    expect(batches.map((batch) => batch.length)).toEqual([4, 1, 150, 150, 60]);
    expect(result.requests).toBe(365);
    expect(result.rounds).toBe(3);
    expect(result.verification.passed).toBe(true);
  });

  it('names the failing phase and that content was written', async () => {
    const { deps } = fakeDeps(live(), { failOnBatch: 2 });
    const error = await copyTabContent(deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TabCopyError);
    expect(error).toMatchObject({ phase: 'skeleton', wroteContent: true, attemptedWrite: true });
  });

  it('marks a write as attempted but not confirmed when the first batch fails', async () => {
    const { deps } = fakeDeps(live(), { failOnBatch: 1 });
    const error = await copyTabContent(deps).catch((e: unknown) => e);
    expect(error).toMatchObject({ phase: 'clear + document styles', wroteContent: false, attemptedWrite: true });
  });

  it('refuses a ragged table before preparing the target or writing anything', async () => {
    const source: Tab = { documentTab: { body: { content: [
      { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
      { table: { rows: 1, columns: 2, tableRows: [{ tableCells: [
        { content: [{ paragraph: { elements: [{ textRun: { content: 'a\n' } }] } }], tableCellStyle: { columnSpan: 2 } },
      ] }] } },
    ] } } };
    const { deps, log, batches } = fakeDeps(source);
    const error = await copyTabContent(deps).catch((e: unknown) => e);
    expect(error).toMatchObject({ phase: 'plan source', wroteContent: false, attemptedWrite: false });
    expect((error as TabCopyError).cause).toBeInstanceOf(DocsInputError);
    expect(log).not.toContain('prepareTarget');
    expect(batches).toHaveLength(0);
  });

  it('fails before preparing the target when a chip check throws', async () => {
    const { deps, log, batches } = fakeDeps(live(), { chipError: new Error('Request had insufficient authentication scopes.') });
    const error = await copyTabContent(deps).catch((e: unknown) => e);
    expect(error).toMatchObject({ phase: 'check smart chips', wroteContent: false, attemptedWrite: false });
    expect(log).not.toContain('prepareTarget');
    expect(batches).toHaveLength(0);
  });
});

/**
 * Scripted end-to-end run on a small source: a heading, a two-item nested
 * bullet list, a 1x2 table with a chip in a cell, a page break and a last
 * line. Each target read is written by hand as the API would return it after
 * the previous round, and the expected table-cell and style requests are
 * written by hand (not produced by the planners).
 */
describe('copyTabContent scripted run', () => {
  const text = (startIndex: number, content: string, textStyle: docs_v1.Schema$TextStyle = {}) =>
    ({ startIndex, endIndex: startIndex + content.length, textRun: { content, textStyle } });
  const chip = (startIndex: number) =>
    ({ startIndex, endIndex: startIndex + 1, richLink: { richLinkProperties: { uri: OK_URI, title: 'Acme plan' }, textStyle: {} } });
  const pageBreak = (startIndex: number) => ({ startIndex, endIndex: startIndex + 1, pageBreak: { textStyle: {} } });
  const normal = { namedStyleType: 'NORMAL_TEXT' };
  const para = (
    startIndex: number,
    endIndex: number,
    elements: docs_v1.Schema$ParagraphElement[],
    extra: Partial<docs_v1.Schema$Paragraph> = {}
  ): docs_v1.Schema$StructuralElement =>
    ({ startIndex, endIndex, paragraph: { elements, paragraphStyle: normal, ...extra } });
  const table = (startIndex: number, endIndex: number, cells: docs_v1.Schema$StructuralElement[][], cellStart: number[]) => ({
    startIndex,
    endIndex,
    table: {
      rows: 1,
      columns: 2,
      tableRows: [{ tableCells: cells.map((content, c) => ({
        startIndex: cellStart[c],
        content,
        ...(c === 0 ? { tableCellStyle: { rowSpan: 1, columnSpan: 1, backgroundColor: { color: { rgbColor: { blue: 1 } } } } } : {}),
      })) }],
    },
  });
  const sectionBreak = { startIndex: 0, endIndex: 1, sectionBreak: {} };
  const heading = { namedStyleType: 'HEADING_1', headingId: 'h.s1' };
  const bulletA = { namedStyleType: 'NORMAL_TEXT', indentStart: pt(36), indentFirstLine: pt(18) };
  const bulletB = { namedStyleType: 'NORMAL_TEXT', indentStart: pt(72), indentFirstLine: pt(54) };

  const source: Tab = {
    documentTab: {
      lists: { 'kix.s1': { listProperties: { nestingLevels: [{ glyphSymbol: '●' }, { glyphSymbol: '○' }] } } },
      body: {
        content: [
          sectionBreak,
          para(1, 6, [text(1, 'Plan\n')], { paragraphStyle: heading }),
          para(6, 8, [text(6, 'A\n')], { bullet: { listId: 'kix.s1' }, paragraphStyle: bulletA }),
          para(8, 10, [text(8, 'B\n', { italic: true })], { bullet: { listId: 'kix.s1', nestingLevel: 1 }, paragraphStyle: bulletB }),
          table(10, 20, [[para(13, 18, [text(13, 'Cost\n')])], [para(19, 21, [chip(19), text(20, '\n')])]], [12, 18]),
          para(21, 23, [pageBreak(21), text(22, '\n')]),
          para(23, 27, [text(23, 'End\n')]),
        ],
      },
    },
  };

  // Read 1: the new, empty tab.
  const t0: Tab = { documentTab: { body: { content: [sectionBreak, para(1, 2, [text(1, '\n')])] } } };
  // Read 2: after the skeleton (the nesting tab is still in "\tB").
  const t1: Tab = { documentTab: { body: { content: [
    sectionBreak,
    para(1, 6, [text(1, 'Plan\n')]),
    para(6, 8, [text(6, 'A\n')]),
    para(8, 11, [text(8, '\tB\n')]),
    table(11, 17, [[para(14, 15, [text(14, '\n')])], [para(16, 17, [text(16, '\n')])]], [13, 15]),
    para(17, 19, [pageBreak(17), text(18, '\n')]),
    para(19, 23, [text(19, 'End\n')]),
  ] } } };
  // Read 3: after the table cells.
  const t2: Tab = { documentTab: { body: { content: [
    sectionBreak,
    para(1, 6, [text(1, 'Plan\n')]),
    para(6, 8, [text(6, 'A\n')]),
    para(8, 11, [text(8, '\tB\n')]),
    table(11, 22, [[para(14, 19, [text(14, 'Cost\n')])], [para(20, 22, [chip(20), text(21, '\n')])]], [13, 19]),
    para(22, 24, [pageBreak(22), text(23, '\n')]),
    para(24, 28, [text(24, 'End\n')]),
  ] } } };
  // Read 4: after styles and bullets (createParagraphBullets removed the tab).
  const t3: Tab = { documentTab: { body: { content: [
    sectionBreak,
    para(1, 6, [text(1, 'Plan\n')], { paragraphStyle: { namedStyleType: 'HEADING_1' } }),
    para(6, 8, [text(6, 'A\n')], { bullet: { listId: 'kix.t1' } }),
    para(8, 10, [text(8, 'B\n', { italic: true })], { bullet: { listId: 'kix.t1', nestingLevel: 1 } }),
    table(10, 21, [[para(13, 18, [text(13, 'Cost\n')])], [para(19, 21, [chip(19), text(20, '\n')])]], [12, 18]),
    para(21, 23, [pageBreak(21), text(22, '\n')]),
    para(23, 27, [text(23, 'End\n')]),
  ] } } };
  // Read 5: after the bullet paragraph styles and table styles.
  const t4 = structuredClone(t3);
  t4.documentTab!.body!.content![2].paragraph!.paragraphStyle = bulletA;
  t4.documentTab!.body!.content![3].paragraph!.paragraphStyle = bulletB;
  const reads = [t0, t1, t2, t3, t4];

  it('sends the hand-written requests in phase order and verifies the result', async () => {
    const batches: TabCopyRequest[][] = [];
    const getTabCalls: string[] = [];
    const result = await copyTabContent({
      getSourceTab: async () => structuredClone(source),
      getTab: async (tabId) => {
        getTabCalls.push(tabId);
        return structuredClone(reads[getTabCalls.length - 1]);
      },
      batchUpdate: async (requests) => {
        batches.push(requests);
      },
      checkChip: async () => true,
      prepareTarget: async () => 't.new',
    });

    const tabId = 't.new';
    const eos = { endOfSegmentLocation: { tabId } };
    const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex, tabId });
    const clear = (s: number, e: number) => ({ updateTextStyle: { range: range(s, e), textStyle: {}, fields: ALL_TEXT_KEYS } });
    const style = (s: number, e: number, paragraphStyle: Record<string, unknown>) =>
      ({ updateParagraphStyle: { range: range(s, e), paragraphStyle, fields: Object.keys(paragraphStyle).join(',') } });

    expect(getTabCalls).toEqual(['t.new', 't.new', 't.new', 't.new', 't.new']);
    expect(batches).toHaveLength(6);
    // Phase 0: reset the empty tab's only paragraph.
    expect(batches[0].map((request) => Object.keys(request)[0])).toEqual(['deleteParagraphBullets', 'updateParagraphStyle', 'updateTextStyle']);
    // Phase 1: skeleton.
    expect(batches[1]).toEqual([
      { insertText: { ...eos, text: 'Plan\nA\n\tB' } },
      { insertTable: { ...eos, rows: 1, columns: 2 } },
      { insertPageBreak: eos },
      { insertText: { ...eos, text: 'End' } },
    ]);
    // Phase 2: table cells, last cell first.
    expect(batches[2]).toEqual([
      { insertRichLink: { location: { index: 16, tabId }, richLinkProperties: { uri: OK_URI } } },
      { insertText: { location: { index: 14, tabId }, text: 'Cost' } },
    ]);
    // Phase 3: units last-first; the bullet unit ends with createParagraphBullets.
    expect(batches[3]).toEqual([
      style(24, 28, normal), clear(24, 28),
      style(22, 24, normal), clear(22, 24),
      style(20, 22, normal), clear(20, 22),
      style(14, 19, normal), clear(14, 19),
      style(6, 8, normal), clear(6, 8),
      style(8, 11, normal), clear(8, 11),
      { updateTextStyle: { range: range(9, 11), textStyle: { italic: true }, fields: 'italic' } },
      { createParagraphBullets: { range: range(6, 11), bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
      style(1, 6, { namedStyleType: 'HEADING_1' }), clear(1, 6),
    ]);
    // Phase 3b: bullet indents back, without namedStyleType.
    expect(batches[4]).toEqual([
      style(6, 8, { indentStart: pt(36), indentFirstLine: pt(18) }),
      style(8, 10, { indentStart: pt(72), indentFirstLine: pt(54) }),
    ]);
    // Phase 4: cell style at the table's index from the Phase 3b read.
    expect(batches[5]).toEqual([
      {
        updateTableCellStyle: {
          tableRange: { tableCellLocation: { tableStartLocation: { index: 10, tabId }, rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: 1 },
          tableCellStyle: { backgroundColor: { color: { rgbColor: { blue: 1 } } } },
          fields: 'backgroundColor',
        },
      },
    ]);
    expect(result.verification).toEqual({
      passed: true,
      checkedParagraphs: 7,
      tables: 1,
      lists: 1,
      placeholders: 0,
      mismatchCount: 0,
      mismatches: [],
    });
    expect(result.chipsCopied).toBe(1);
  });
});
