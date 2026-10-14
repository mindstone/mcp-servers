import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { docs_v1 } from 'googleapis';
import {
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
} from '../src/modules/docs/tabs.js';
import { normalizeArgs } from '../src/tools/param-normalizer.js';
import {
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
