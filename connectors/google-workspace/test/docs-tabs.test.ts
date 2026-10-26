import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { docs_v1 } from 'googleapis';
import {
  ALL_TEXT_KEYS,
  DocsInputError,
  TAB_TREE_FIELDS,
  TAB_TRUNCATION_MARKER,
  TRUNCATION_MARKER,
  bodyEndIndex,
  buildAllTabsText,
  buildTabTreeFields,
  countWords,
  extractBodyText,
  flattenTabs,
  requireTabs,
  resolveTab,
  assertUniqueTitle,
  descendantsOf,
  siblingsOf,
  flatParagraphs,
  paragraphSearchText,
  findAnchor,
  nextParagraphInContainer,
  normalizeInsertText,
  TAB_READ_TEXT_OPTIONS,
} from '../src/modules/docs/tabs.js';
import { computeMoveApiIndex } from '../src/utils/tabPosition.js';
import { normalizeArgs } from '../src/tools/param-normalizer.js';
import {
  isAddDocumentTabArgs,
  isDeleteDocumentTabArgs,
  isInsertDocumentTextArgs,
  isUpdateDocumentTabArgs,
  isAppendDocumentArgs,
  isFindReplaceArgs,
  isListTabsArgs,
  isReadDocumentArgs,
  isReplaceDocumentArgs,
} from '../src/tools/type-guards.js';

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/docs-tabs/nested-doc.json');

function loadNestedDoc(): docs_v1.Schema$Document {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as docs_v1.Schema$Document;
}

function bodyOf(doc: docs_v1.Schema$Document, tabId: string): docs_v1.Schema$Body | undefined {
  return flattenTabs(doc.tabs).find((tab) => tab.tabId === tabId)?.tab.documentTab?.body;
}

describe('flattenTabs', () => {
  it('walks the tab tree in pre-order with parent, depth, path and child counts', () => {
    const flat = flattenTabs(loadNestedDoc().tabs);

    expect(flat.map((tab) => ({
      tabId: tab.tabId,
      parentTabId: tab.parentTabId,
      index: tab.index,
      nestingLevel: tab.nestingLevel,
      path: tab.path,
      childCount: tab.childCount,
    }))).toEqual([
      { tabId: 't.0', parentTabId: null, index: 0, nestingLevel: 0, path: 'Team sync', childCount: 2 },
      { tabId: 't.a1', parentTabId: 't.0', index: 0, nestingLevel: 1, path: 'Team sync > Archive 2031-10-06', childCount: 1 },
      { tabId: 't.a1x', parentTabId: 't.a1', index: 0, nestingLevel: 2, path: 'Team sync > Archive 2031-10-06 > Notes', childCount: 0 },
      { tabId: 't.a2', parentTabId: 't.0', index: 1, nestingLevel: 1, path: 'Team sync > Archive 2031-09-29', childCount: 0 },
      { tabId: 't.b', parentTabId: null, index: 1, nestingLevel: 0, path: 'Template', childCount: 0 },
      { tabId: 't.c', parentTabId: null, index: 2, nestingLevel: 0, path: 'Campaign notes', childCount: 0 },
    ]);
  });

  it('falls back to the array position when tabProperties.index is absent', () => {
    const flat = flattenTabs([
      { tabProperties: { tabId: 't.x', title: 'First' } },
      { tabProperties: { tabId: 't.y', title: 'Second' } },
    ]);
    expect(flat.map((tab) => tab.index)).toEqual([0, 1]);
  });

  it('returns an empty list for a missing tab array', () => {
    expect(flattenTabs(undefined)).toEqual([]);
  });
});

describe('buildTabTreeFields', () => {
  it('nests childTabs to the requested depth', () => {
    expect(buildTabTreeFields(2)).toBe(
      'tabs(tabProperties,childTabs(tabProperties,childTabs(tabProperties)))'
    );
  });

  it('defaults to depth 6 and keeps document id, title and revision in the tree mask', () => {
    expect(TAB_TREE_FIELDS).toBe('documentId,title,revisionId,' + buildTabTreeFields(6));
    expect(buildTabTreeFields().match(/childTabs\(/g)).toHaveLength(6);
  });
});

describe('resolveTab', () => {
  const flat = flattenTabs(loadNestedDoc().tabs);

  it('finds a tab by id at any depth', () => {
    expect(resolveTab(flat, 't.a1x', { allowDefault: false }).path).toBe('Team sync > Archive 2031-10-06 > Notes');
  });

  it('maps "default" to the first top-level tab when allowed', () => {
    expect(resolveTab(flat, 'default', { allowDefault: true }).tabId).toBe('t.0');
  });

  it('refuses "default" where it is not allowed', () => {
    expect(() => resolveTab(flat, 'default', { allowDefault: false })).toThrowError(
      'Pass a real tab id from list_workspace_document_tabs; "default" is not accepted by tools that delete, move, rename or overwrite a tab.'
    );
  });

  it('throws an InvalidParams DocsInputError for an unknown id without echoing titles', () => {
    let caught: unknown;
    try {
      resolveTab(flat, 't.missing', { allowDefault: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocsInputError);
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((caught as Error).message).toContain(
      'Tab "t.missing" not found in this document. Call list_workspace_document_tabs to see tab ids.'
    );
    expect((caught as Error).message).not.toContain('Team sync');
  });
});

describe('extractBodyText', () => {
  const doc = loadNestedDoc();
  const chipsBody = bodyOf(doc, 't.c');

  it('keeps the original output without options: text runs only, a newline after each table row', () => {
    expect(extractBodyText(chipsBody)).toBe('See  with  on \nPlatform\nSpend\n\nSearch\n120\n\nEnd\n');
  });

  it('renders rich links, people and dates in place with renderInline', () => {
    expect(extractBodyText(chipsBody, { renderInline: true })).toBe(
      'See Q3 plan with Jane Example <jane@example.com> on Oct 13, 2031\nPlatform\nSpend\n\nSearch\n120\n\nEnd\n'
    );
  });

  it('falls back to the link URI, the person name or email alone', () => {
    const body: docs_v1.Schema$Body = {
      content: [{
        paragraph: {
          elements: [
            { richLink: { richLinkProperties: { uri: 'https://example.com/file' } } },
            { textRun: { content: ' | ' } },
            { person: { personProperties: { name: 'Sam Example' } } },
            { textRun: { content: ' | ' } },
            { person: { personProperties: { email: 'sam@example.com' } } },
            { textRun: { content: '\n' } },
          ],
        },
      }],
    };
    expect(extractBodyText(body, { renderInline: true })).toBe('https://example.com/file | Sam Example | sam@example.com\n');
  });

  it('matches the pre-tabs DocsService.extractTextFromBody on every fixture tab', () => {
    // Verbatim copy of the extractor this helper replaced.
    const legacyExtract = (body: docs_v1.Schema$Body | undefined): string => {
      if (!body?.content) return '';
      const textParts: string[] = [];
      for (const element of body.content) {
        if (element.paragraph?.elements) {
          for (const paragraphElement of element.paragraph.elements) {
            if (paragraphElement.textRun?.content) textParts.push(paragraphElement.textRun.content);
          }
        } else if (element.table) {
          for (const row of element.table.tableRows || []) {
            for (const cell of row.tableCells || []) {
              if (cell.content) {
                for (const cellElement of cell.content) {
                  if (cellElement.paragraph?.elements) {
                    for (const pe of cellElement.paragraph.elements) {
                      if (pe.textRun?.content) textParts.push(pe.textRun.content);
                    }
                  }
                }
              }
            }
            textParts.push('\n');
          }
        }
      }
      return textParts.join('');
    };
    for (const tab of flattenTabs(doc.tabs)) {
      expect(extractBodyText(tab.tab.documentTab?.body)).toBe(legacyExtract(tab.tab.documentTab?.body));
    }
  });

  it('returns an empty string for a missing body', () => {
    expect(extractBodyText(undefined)).toBe('');
  });
});

describe('countWords / bodyEndIndex / requireTabs', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('  Weekly notes\nOwner: Jane\n')).toBe(4);
  });

  it('returns the index before the final newline, or 1 for an empty body', () => {
    expect(bodyEndIndex(bodyOf(loadNestedDoc(), 't.0'))).toBe(25);
    expect(bodyEndIndex({ content: [] })).toBe(1);
    expect(bodyEndIndex(undefined)).toBe(1);
  });

  it('fails loudly when an includeTabsContent read has no tabs', () => {
    expect(() => requireTabs({ documentId: 'x', body: { content: [] } })).toThrowError(
      'Docs API returned no tabs for an includeTabsContent read'
    );
    expect(requireTabs(loadNestedDoc())).toHaveLength(3);
  });
});

describe('buildAllTabsText', () => {
  const flat = flattenTabs(loadNestedDoc().tabs);

  it('shows every tab under a heading when the budget allows', () => {
    const result = buildAllTabsText(flat, 50_000);
    expect(result.truncated).toBe(false);
    expect(result.shownCount).toBe(6);
    expect(result.content.startsWith('## Tab: Team sync [tabId: t.0]\nWeekly notes\nOwner: Jane\n\n')).toBe(true);
    expect(result.content).toContain('## Tab: Team sync > Archive 2031-10-06 > Notes [tabId: t.a1x]\nNested note\n');
    expect(result.content).toContain('Jane Example <jane@example.com>');
    expect(result.content).not.toContain('[Not shown');
  });

  it('shares one budget across tabs, cuts the crossing tab and lists it and the rest by id', () => {
    // t.0 = 25 chars, t.a1 = 22 chars: a 30-char budget cuts t.a1 after 5 chars.
    const result = buildAllTabsText(flat, 30);
    expect(result.truncated).toBe(true);
    expect(result.shownCount).toBe(2);
    expect(result.content).toBe(
      '## Tab: Team sync [tabId: t.0]\nWeekly notes\nOwner: Jane\n\n' +
        '## Tab: Team sync > Archive 2031-10-06 [tabId: t.a1]\nArchi' +
        '\n\n[TRUNCATED - this tab continues past the max_chars budget]\n' +
        '\n[Not shown in full — over the max_chars budget; read them with tab_id]:\n' +
        '- Team sync > Archive 2031-10-06 [tabId: t.a1] (cut short)\n' +
        '- Team sync > Archive 2031-10-06 > Notes [tabId: t.a1x]\n' +
        '- Team sync > Archive 2031-09-29 [tabId: t.a2]\n' +
        '- Template [tabId: t.b]\n' +
        '- Campaign notes [tabId: t.c]'
    );
  });

  it('lists the following tabs when a tab exactly fills the budget', () => {
    const result = buildAllTabsText(flat, 25);
    expect(result.shownCount).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.content).not.toContain(TAB_TRUNCATION_MARKER);
    expect(result.content).not.toContain(TRUNCATION_MARKER);
    expect(result.content).not.toContain('(cut short)');
    expect(result.content).toContain('- Team sync > Archive 2031-10-06 [tabId: t.a1]\n');
  });

  it('names the cut tab in the final list even when no tab follows it', () => {
    // Campaign notes is the last tab: a budget that ends inside it lists only it.
    const lastOnly = flat.filter((tab) => tab.tabId === 't.c');
    const result = buildAllTabsText(lastOnly, 5);
    expect(result.truncated).toBe(true);
    expect(result.shownCount).toBe(1);
    expect(result.content.endsWith(
      `${TAB_TRUNCATION_MARKER}\n` +
        '\n[Not shown in full — over the max_chars budget; read them with tab_id]:\n' +
        '- Campaign notes [tabId: t.c] (cut short)'
    )).toBe(true);
  });
});

describe('server argument path for tab arguments (normalizeArgs + type guards)', () => {
  // The server normalizes camelCase aliases to canonical keys, then runs the
  // guard before the handler; the handler-level tests above skip both steps.
  const base = { document_id: 'nested-doc' };

  it('maps tabId / allTabs to tab_id / all_tabs and keeps an explicit canonical key', () => {
    expect(normalizeArgs({ ...base, tabId: 't.b', allTabs: true })).toMatchObject({ tab_id: 't.b', all_tabs: true });
    expect(normalizeArgs({ ...base, tab_id: 't.c', tabId: 't.b' })).toMatchObject({ tab_id: 't.c' });
  });

  it('accepts tab arguments in canonical and camelCase form on every Docs tool that takes them', () => {
    for (const tab of [{ tab_id: 't.b' }, { tabId: 't.b' }]) {
      const viaServer = (args: Record<string, unknown>) => normalizeArgs({ ...args, ...tab });
      expect(isReadDocumentArgs(viaServer(base))).toBe(true);
      expect(isAppendDocumentArgs(viaServer({ ...base, text: 'x' }))).toBe(true);
      expect(isReplaceDocumentArgs(viaServer({ ...base, content: 'x' }))).toBe(true);
      expect(isFindReplaceArgs(viaServer({ ...base, find_text: 'a', replace_text: 'b' }))).toBe(true);
    }
    expect(isReadDocumentArgs(normalizeArgs({ ...base, all_tabs: true }))).toBe(true);
    expect(isReadDocumentArgs(normalizeArgs({ ...base, allTabs: false }))).toBe(true);
    expect(isListTabsArgs(normalizeArgs({ ...base, return_json: true }))).toBe(true);
    expect(isListTabsArgs(normalizeArgs({ ...base, returnJson: true }))).toBe(true);
  });

  it('rejects wrong-typed tab arguments', () => {
    expect(isReadDocumentArgs(normalizeArgs({ ...base, tab_id: 3 }))).toBe(false);
    expect(isReadDocumentArgs(normalizeArgs({ ...base, tabId: ['t.b'] }))).toBe(false);
    expect(isReadDocumentArgs(normalizeArgs({ ...base, all_tabs: 'yes' }))).toBe(false);
    expect(isReadDocumentArgs(normalizeArgs({ ...base, allTabs: 1 }))).toBe(false);
    expect(isAppendDocumentArgs(normalizeArgs({ ...base, text: 'x', tab_id: 3 }))).toBe(false);
    expect(isReplaceDocumentArgs(normalizeArgs({ ...base, content: 'x', tabId: {} }))).toBe(false);
    expect(isFindReplaceArgs(normalizeArgs({ ...base, find_text: 'a', replace_text: 'b', tab_id: true }))).toBe(false);
    expect(isListTabsArgs(normalizeArgs({ ...base, return_json: 'true' }))).toBe(false);
  });
});

describe('computeMoveApiIndex', () => {
  // Siblings [A, B, C]; the API counts the target index before the moved tab is removed.
  it.each([
    ['A → 1 (forward)', { currentIndex: 0, targetPosition: 1 }, 2],
    ['A → 2 (forward to the end)', { currentIndex: 0, targetPosition: 2 }, 3],
    ['C → 0 (backward)', { currentIndex: 2, targetPosition: 0 }, 0],
    ['B → 0 (backward)', { currentIndex: 1, targetPosition: 0 }, 0],
    ['B → 2 (forward)', { currentIndex: 1, targetPosition: 2 }, 3],
    ['B → 1 (same place)', { currentIndex: 1, targetPosition: 1 }, 1],
  ])('same parent, %s', (_label, move, expected) => {
    expect(computeMoveApiIndex({ sameParent: true, ...move })).toBe(expected);
  });

  it('leaves the position unchanged for a move to a different parent (re-parent or to the top level)', () => {
    expect(computeMoveApiIndex({ sameParent: false, currentIndex: 0, targetPosition: 2 })).toBe(2);
    expect(computeMoveApiIndex({ sameParent: false, currentIndex: 3, targetPosition: 0 })).toBe(0);
    expect(computeMoveApiIndex({ sameParent: false, currentIndex: 0, targetPosition: 0 })).toBe(0);
  });
});

describe('tab tree helpers for tab management', () => {
  const flat = flattenTabs(loadNestedDoc().tabs);

  it('assertUniqueTitle refuses a title used anywhere in the document, sub-tabs included, after trimming', () => {
    expect(() => assertUniqueTitle(flat, 'Notes')).toThrowError(
      'A tab titled "Notes" already exists. Tab titles must be unique across the whole document, including sub-tabs.'
    );
    expect(() => assertUniqueTitle(flat, '  Template ')).toThrowError(DocsInputError);
    expect(() => assertUniqueTitle(flat, 'Archive 2031-10-13')).not.toThrow();
    // Exact match: a case variant is left to the API.
    expect(() => assertUniqueTitle(flat, 'template')).not.toThrow();
    // The tab being renamed may keep its own title.
    expect(() => assertUniqueTitle(flat, 'Template', 't.b')).not.toThrow();
  });

  it('descendantsOf returns every tab below a tab in tree order', () => {
    expect(descendantsOf(flat, 't.0').map((tab) => tab.tabId)).toEqual(['t.a1', 't.a1x', 't.a2']);
    expect(descendantsOf(flat, 't.a1').map((tab) => tab.tabId)).toEqual(['t.a1x']);
    expect(descendantsOf(flat, 't.b')).toEqual([]);
    expect(descendantsOf(flat, 't.missing')).toEqual([]);
  });

  it('siblingsOf returns the direct children of a parent (null = top level)', () => {
    expect(siblingsOf(flat, null).map((tab) => tab.tabId)).toEqual(['t.0', 't.b', 't.c']);
    expect(siblingsOf(flat, 't.0').map((tab) => tab.tabId)).toEqual(['t.a1', 't.a2']);
    expect(siblingsOf(flat, 't.a2')).toEqual([]);
  });

  it('exports the full text-style field list used to clear run styles', () => {
    expect(ALL_TEXT_KEYS).toBe(
      'bold,italic,underline,strikethrough,smallCaps,fontSize,foregroundColor,backgroundColor,weightedFontFamily,baselineOffset,link'
    );
  });
});

function textParagraph(startIndex: number, content: string, extra: Partial<docs_v1.Schema$Paragraph> = {}): docs_v1.Schema$StructuralElement {
  return {
    startIndex,
    endIndex: startIndex + content.length,
    paragraph: { elements: [{ startIndex, endIndex: startIndex + content.length, textRun: { content } }], ...extra },
  };
}

/** Fictional body: heading, empty bullet, a chip + emoji paragraph, a 1×2 table, a final paragraph. */
function anchorBody(): docs_v1.Schema$Body {
  return {
    content: [
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      textParagraph(1, 'Out of office\n', { paragraphStyle: { namedStyleType: 'HEADING_2' } }), // 1..15
      textParagraph(15, '\n', { bullet: { listId: 'kix.list1' } }), // 15..16
      {
        startIndex: 16,
        endIndex: 33,
        paragraph: {
          elements: [
            { startIndex: 16, endIndex: 20, textRun: { content: 'See ' } },
            { startIndex: 20, endIndex: 21, richLink: { richLinkProperties: { title: 'Plan', uri: 'https://example.com/plan' } } },
            // "🎉" is 2 UTF-16 units, so 2 document indices.
            { startIndex: 21, endIndex: 33, textRun: { content: ' 🎉 Approved\n' } },
          ],
        },
      },
      {
        startIndex: 33,
        endIndex: 55,
        table: {
          rows: 1,
          columns: 2,
          tableRows: [{
            startIndex: 34,
            endIndex: 54,
            tableCells: [
              { startIndex: 34, endIndex: 47, content: [textParagraph(35, 'Search\n'), textParagraph(42, 'Ads\n')] }, // 35..42, 42..46
              { startIndex: 47, endIndex: 54, content: [textParagraph(48, 'Spend\n')] }, // 48..54
            ],
          }],
        },
      },
      textParagraph(55, 'End of office notes\n'),
    ],
  };
}

describe('anchored-insert helpers', () => {
  const body = anchorBody();
  const paragraphs = flatParagraphs(body);

  it('flatParagraphs lists body and table-cell paragraphs in document order with their container', () => {
    expect(paragraphs.map((entry) => [entry.startIndex, entry.container])).toEqual([
      [1, 'body'],
      [15, 'body'],
      [16, 'body'],
      [35, { table: 0, row: 0, col: 0 }],
      [42, { table: 0, row: 0, col: 0 }],
      [48, { table: 0, row: 0, col: 1 }],
      [55, 'body'],
    ]);
  });

  it('paragraphSearchText keeps document-index offsets across a chip and a non-BMP character', () => {
    const text = paragraphSearchText(paragraphs[2].paragraph);
    expect(text).toBe('See ￼ 🎉 Approved\n');
    const [match] = findAnchor(paragraphs, 'Approved', true);
    // "Approved" starts at document index 25: 16 + "See " (4) + chip (1) + " 🎉 " (4 units).
    expect(paragraphs[match.paragraphIdx].startIndex + match.offset).toBe(25);
  });

  it('findAnchor finds 0, 1 or several matches, each inside one paragraph', () => {
    expect(findAnchor(paragraphs, 'Holiday', true)).toEqual([]);
    expect(findAnchor(paragraphs, 'Out of office', true)).toEqual([{ paragraphIdx: 0, offset: 0 }]);
    expect(findAnchor(paragraphs, 'office', true)).toEqual([
      { paragraphIdx: 0, offset: 7 },
      { paragraphIdx: 6, offset: 7 },
    ]);
    // Never through a smart chip (its title is not searchable text).
    expect(findAnchor(paragraphs, 'See Plan', true)).toEqual([]);
  });

  it('findAnchor matches case-insensitively one character at a time when matchCase is off', () => {
    expect(findAnchor(paragraphs, 'OUT OF OFFICE', false)).toEqual([{ paragraphIdx: 0, offset: 0 }]);
    expect(findAnchor(paragraphs, 'OUT OF OFFICE', true)).toEqual([]);
    // "İ" lower-cases to two UTF-16 units; per-character folding keeps the offset exact.
    const turkish = flatParagraphs({ content: [textParagraph(1, 'xİstanbul plan\n')] });
    expect(findAnchor(turkish, 'plan', false)).toEqual([{ paragraphIdx: 0, offset: 10 }]);
    expect(findAnchor(turkish, 'İSTANBUL', false)).toEqual([{ paragraphIdx: 0, offset: 1 }]);
  });

  it('findAnchor finds an anchor inside a table cell', () => {
    const [match] = findAnchor(paragraphs, 'Spend', true);
    expect(paragraphs[match.paragraphIdx].container).toEqual({ table: 0, row: 0, col: 1 });
  });

  it('findAnchor refuses an empty or multi-line anchor', () => {
    expect(() => findAnchor(paragraphs, 'Out of\noffice', true)).toThrowError('anchor_text must be on one line.');
    expect(() => findAnchor(paragraphs, '', true)).toThrowError(DocsInputError);
  });

  it('nextParagraphInContainer stays in the same container', () => {
    expect(nextParagraphInContainer(body, paragraphs, 0).startIndex).toBe(15);
    expect(nextParagraphInContainer(body, paragraphs, 3).startIndex).toBe(42);
    const followedByTable = 'The anchor paragraph is followed by a table (or nothing); use position "after" instead.';
    // Body paragraph followed by a table, last paragraph of a cell, last paragraph of the body.
    expect(() => nextParagraphInContainer(body, paragraphs, 2)).toThrowError(followedByTable);
    expect(() => nextParagraphInContainer(body, paragraphs, 4)).toThrowError(followedByTable);
    expect(() => nextParagraphInContainer(body, paragraphs, 5)).toThrowError(followedByTable);
    expect(() => nextParagraphInContainer(body, paragraphs, 6)).toThrowError(followedByTable);
  });
});

describe('structure markers on tab reads', () => {
  const body: docs_v1.Schema$Body = {
    content: [
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      textParagraph(1, 'Weekly sync\n', { paragraphStyle: { namedStyleType: 'TITLE' } }),
      textParagraph(13, 'Out of office\n', { paragraphStyle: { namedStyleType: 'HEADING_2' } }),
      textParagraph(27, 'List anyone away next week:\n', { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } }),
      textParagraph(55, '\n', { bullet: { listId: 'kix.a' } }),
      textParagraph(56, 'Jane\n', { bullet: { listId: 'kix.a', nestingLevel: 1 } }),
      {
        startIndex: 61,
        endIndex: 72,
        table: {
          tableRows: [{ tableCells: [{ content: [textParagraph(63, 'Cell item\n', { bullet: { listId: 'kix.b' } })] }] }],
        },
      },
    ],
  };

  it('prefixes headings with [H1]-style markers and list items with an indented bullet', () => {
    expect(extractBodyText(body, TAB_READ_TEXT_OPTIONS)).toBe(
      '[Title] Weekly sync\n[H2] Out of office\nList anyone away next week:\n• \n  • Jane\n• Cell item\n\n'
    );
  });

  it('adds no markers without markStructure (the no-tab read)', () => {
    expect(extractBodyText(body)).toBe('Weekly sync\nOut of office\nList anyone away next week:\n\nJane\nCell item\n\n');
    expect(extractBodyText(body, { renderInline: true })).toBe(extractBodyText(body));
  });
});

describe('normalizeInsertText', () => {
  it('turns CRLF and lone CR into newlines without counting them as removed', () => {
    expect(normalizeInsertText('a\r\nb\rc\n')).toEqual({ text: 'a\nb\nc\n', removedChars: 0 });
  });

  it('removes the control and private-use characters Docs strips, keeping tab, newline and U+000B', () => {
    expect(normalizeInsertText('\u0000\u0008\t\n\u000B\u000C\u001F\uE000\uF8FF\uF900x')).toEqual({
      text: '\t\n\u000B\uF900x',
      removedChars: 6,
    });
  });

  it('leaves ordinary text, including non-BMP characters, unchanged', () => {
    expect(normalizeInsertText('Jane: Oct 20-24 \u{1F389}')).toEqual({ text: 'Jane: Oct 20-24 \u{1F389}', removedChars: 0 });
  });
});

describe('server argument path for the tab-management and insert tools', () => {
  const base = { document_id: 'nested-doc' };

  it('maps camelCase aliases to canonical keys', () => {
    expect(normalizeArgs({ ...base, parentTabId: 't.0', anchorText: 'x', expectEmptyParagraph: true, deleteSubTabs: true }))
      .toMatchObject({ parent_tab_id: 't.0', anchor_text: 'x', expect_empty_paragraph: true, delete_sub_tabs: true });
    // move_to_top_level was dropped (the API rejects clearing parentTabId): no alias for it.
    expect(normalizeArgs({ ...base, moveToTopLevel: true })).not.toHaveProperty('move_to_top_level');
  });

  it('accepts well-typed arguments in canonical and camelCase form', () => {
    expect(isAddDocumentTabArgs(normalizeArgs({ ...base, title: 'Q4', parentTabId: 't.0', position: 0 }))).toBe(true);
    expect(isUpdateDocumentTabArgs(normalizeArgs({ ...base, tabId: 't.b', title: 'New', parentTabId: 't.0', position: 1 }))).toBe(true);
    expect(isDeleteDocumentTabArgs(normalizeArgs({ ...base, tab_id: 't.b' }))).toBe(true);
    expect(isDeleteDocumentTabArgs(normalizeArgs({ ...base, tab_id: 't.b', deleteSubTabs: true }))).toBe(true);
    expect(isInsertDocumentTextArgs(normalizeArgs({ ...base, anchorText: 'Out of office', text: 'x', position: 'next_paragraph_start', expectEmptyParagraph: true }))).toBe(true);
  });

  it('rejects missing or wrong-typed arguments', () => {
    expect(isAddDocumentTabArgs(normalizeArgs({ ...base }))).toBe(false);
    expect(isAddDocumentTabArgs(normalizeArgs({ ...base, title: 'Q4', position: '0' }))).toBe(false);
    expect(isUpdateDocumentTabArgs(normalizeArgs({ ...base, title: 'x' }))).toBe(false);
    expect(isUpdateDocumentTabArgs(normalizeArgs({ ...base, tab_id: 't.b', parent_tab_id: 3 }))).toBe(false);
    expect(isDeleteDocumentTabArgs(normalizeArgs({ ...base }))).toBe(false);
    expect(isDeleteDocumentTabArgs(normalizeArgs({ ...base, tab_id: 't.b', delete_sub_tabs: 'yes' }))).toBe(false);
    expect(isInsertDocumentTextArgs(normalizeArgs({ ...base, text: 'x' }))).toBe(false);
    expect(isInsertDocumentTextArgs(normalizeArgs({ ...base, anchor_text: 'a', text: 'x', position: 2 }))).toBe(false);
    expect(isInsertDocumentTextArgs(normalizeArgs({ ...base, anchor_text: 'a', text: 'x', expect_empty_paragraph: 1 }))).toBe(false);
  });
});
