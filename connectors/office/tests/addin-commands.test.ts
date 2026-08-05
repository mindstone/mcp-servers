/**
 * Command-level tests for the add-in command handlers, driving the real
 * handler functions with mocked Office.js contexts (the `Word` / `Excel` /
 * `PowerPoint` globals are replaced with `run()` shims that invoke the
 * callback with a fake request context).
 *
 * These cover the behavior the sidecar relay tests cannot: actual cell
 * mutation, paragraph targeting, pivot creation/refresh, layout resolution,
 * and shape lookup/format/delete — including malformed conditional inputs and
 * out-of-range targets.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../src/addin/officeExecutor.js';
import { getWordCommandHandler } from '../src/addin/commands/wordCommands.js';
import { getExcelCommandHandler } from '../src/addin/commands/excelCommands.js';
import { getPowerpointCommandHandler } from '../src/addin/commands/powerpointCommands.js';

const g = globalThis as Record<string, unknown>;

type Handler = (params: Record<string, unknown>) => Promise<CommandResult>;

function mustGet(handler: Handler | null, action: string): Handler {
  if (!handler) throw new Error(`no handler registered for ${action}`);
  return handler;
}

/** Install a `{App}.run` global shim that feeds `context` to the callback. */
function mockOfficeApp(app: 'Word' | 'Excel' | 'PowerPoint', context: unknown): void {
  g[app] = {
    run: async (fn: (ctx: unknown) => Promise<unknown>) => await fn(context),
  };
}

afterEach(() => {
  delete g.Word;
  delete g.Excel;
  delete g.PowerPoint;
});

// ---------------------------------------------------------------------------
// Word — update_table_cell
// ---------------------------------------------------------------------------

function makeWordTableContext() {
  const cells = [
    [{ value: 'a1' }, { value: 'b1' }],
    [{ value: 'a2' }, { value: 'b2' }],
  ];
  const table = {
    values: [
      ['a1', 'b1'],
      ['a2', 'b2'],
    ],
    rowCount: 2,
    load: vi.fn(),
    getCell: (row: number, column: number) => cells[row]![column]!,
  };
  const context = {
    document: { body: { tables: { items: [table], load: vi.fn() } } },
    sync: vi.fn(async () => {}),
  };
  return { context, table, cells };
}

describe('word update_table_cell', () => {
  const handler = () => mustGet(getWordCommandHandler('update_table_cell'), 'update_table_cell');

  it('writes the text into the addressed cell', async () => {
    const { context, cells } = makeWordTableContext();
    mockOfficeApp('Word', context);

    const result = await handler()({ tableIndex: 0, rowIndex: 1, columnIndex: 1, text: 'Updated' });

    expect(result.success).toBe(true);
    expect(cells[1]![1]!.value).toBe('Updated');
    expect(cells[0]![0]!.value).toBe('a1');
  });

  it('rejects out-of-range row/column with the table dimensions in the error', async () => {
    const { context } = makeWordTableContext();
    mockOfficeApp('Word', context);

    const result = await handler()({ rowIndex: 5, columnIndex: 0, text: 'x' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('out of range');
      expect(result.error).toContain('2 row(s)');
    }
  });

  it('rejects an out-of-range tableIndex', async () => {
    const { context } = makeWordTableContext();
    mockOfficeApp('Word', context);

    const result = await handler()({ tableIndex: 3, rowIndex: 0, columnIndex: 0, text: 'x' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Table index 3 out of range');
  });

  it.each([
    ['missing text', { rowIndex: 0, columnIndex: 0 }],
    ['negative rowIndex', { rowIndex: -1, columnIndex: 0, text: 'x' }],
    ['non-integer columnIndex', { rowIndex: 0, columnIndex: 0.5, text: 'x' }],
  ])('rejects malformed input pre-flight: %s', async (_label, params) => {
    // No Word global installed — reaching the executor would throw, so a clean
    // INVALID_ARGUMENT proves validation happened before any Office call.
    const result = await handler()(params);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('INVALID_ARGUMENT');
  });
});

// ---------------------------------------------------------------------------
// Word — apply_style
// ---------------------------------------------------------------------------

function makeWordParagraphsContext(paragraphTexts: string[]) {
  const paragraphs = paragraphTexts.map((text) => ({ text, style: '' }));
  const body = { paragraphs: { items: paragraphs, load: vi.fn() } };
  const selection = { paragraphs: { items: [] as typeof paragraphs, load: vi.fn() } };
  const context = {
    document: { body, getSelection: () => selection },
    sync: vi.fn(async () => {}),
  };
  return { context, paragraphs, selection };
}

describe('word apply_style', () => {
  const handler = () => mustGet(getWordCommandHandler('apply_style'), 'apply_style');

  it('styles only the paragraphs containing the search text', async () => {
    const { context, paragraphs } = makeWordParagraphsContext([
      'Quarterly results',
      'Unrelated paragraph',
      'Quarterly outlook',
    ]);
    mockOfficeApp('Word', context);

    const result = await handler()({
      style: 'Quote',
      target: { type: 'searchText', searchText: 'Quarterly' },
    });

    expect(result.success).toBe(true);
    expect(paragraphs[0]!.style).toBe('Quote');
    expect(paragraphs[1]!.style).toBe('');
    expect(paragraphs[2]!.style).toBe('Quote');
    if (result.success) {
      expect((result.data as { styledParagraphs: number }).styledParagraphs).toBe(2);
    }
  });

  it('styles the requested paragraph range, inclusive', async () => {
    const { context, paragraphs } = makeWordParagraphsContext(['p0', 'p1', 'p2']);
    mockOfficeApp('Word', context);

    const result = await handler()({
      style: 'Heading 1',
      target: { type: 'paragraphRange', startParagraph: 1, endParagraph: 2 },
    });

    expect(result.success).toBe(true);
    expect(paragraphs[0]!.style).toBe('');
    expect(paragraphs[1]!.style).toBe('Heading 1');
    expect(paragraphs[2]!.style).toBe('Heading 1');
  });

  it('fails cleanly when a searchText target has no searchText', async () => {
    const { context } = makeWordParagraphsContext(['p0']);
    mockOfficeApp('Word', context);

    const result = await handler()({ style: 'Quote', target: { type: 'searchText' } });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('searchText');
  });

  it('fails cleanly when the selection contains no paragraphs', async () => {
    const { context } = makeWordParagraphsContext(['p0']);
    mockOfficeApp('Word', context);

    const result = await handler()({ style: 'Quote', target: { type: 'selection' } });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('no paragraphs');
  });
});

// ---------------------------------------------------------------------------
// Excel — pivot tables
// ---------------------------------------------------------------------------

function makeExcelPivotContext() {
  const calls = {
    worksheetsAdd: vi.fn(),
    pivotAdd: vi.fn(),
    refresh: vi.fn(),
    refreshAll: vi.fn(),
  };
  const makeSheet = (name: string) => ({
    name,
    load: vi.fn(),
    getRange: (address: string) => ({ address }),
    pivotTables: {
      add: (pivotName: string, source: unknown, destination: unknown) => {
        calls.pivotAdd(pivotName, source, destination);
        return { name: pivotName, load: vi.fn() };
      },
    },
  });
  const sourceSheet = makeSheet('Data');
  const destSheet = makeSheet('Report');
  const context = {
    workbook: {
      worksheets: {
        getActiveWorksheet: () => sourceSheet,
        getItem: (name: string) => {
          if (name === 'Report') return destSheet;
          throw new Error(`worksheet ${name} not found`);
        },
        add: (name: string) => {
          calls.worksheetsAdd(name);
          return makeSheet(name);
        },
      },
      pivotTables: {
        getItem: (_name: string) => ({ refresh: calls.refresh }),
        refreshAll: calls.refreshAll,
      },
    },
    sync: vi.fn(async () => {}),
  };
  return { context, calls, sourceSheet, destSheet };
}

describe('excel create_pivot_table', () => {
  const handler = () => mustGet(getExcelCommandHandler('create_pivot_table'), 'create_pivot_table');

  it('creates the pivot on a new worksheet when no destination is given', async () => {
    const { context, calls } = makeExcelPivotContext();
    mockOfficeApp('Excel', context);

    const result = await handler()({ name: 'Summary', sourceRange: 'A1:D100' });

    expect(result.success).toBe(true);
    expect(calls.worksheetsAdd).toHaveBeenCalledWith('Summary');
    expect(calls.pivotAdd).toHaveBeenCalledWith(
      'Summary',
      { address: 'A1:D100' },
      { address: 'A1' },
    );
  });

  it('places the pivot on the named destination worksheet and cell', async () => {
    const { context, calls } = makeExcelPivotContext();
    mockOfficeApp('Excel', context);

    const result = await handler()({
      name: 'Summary',
      sourceRange: 'A1:D100',
      destinationWorksheet: 'Report',
      destinationCell: 'B3',
    });

    expect(result.success).toBe(true);
    expect(calls.worksheetsAdd).not.toHaveBeenCalled();
    expect(calls.pivotAdd).toHaveBeenCalledWith(
      'Summary',
      { address: 'A1:D100' },
      { address: 'B3' },
    );
    if (result.success) {
      expect((result.data as { worksheet: string }).worksheet).toBe('Report');
    }
  });

  it.each([
    ['missing name', { sourceRange: 'A1:D100' }],
    ['empty sourceRange', { name: 'Summary', sourceRange: '  ' }],
  ])('rejects malformed input pre-flight: %s', async (_label, params) => {
    const result = await handler()(params);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('INVALID_ARGUMENT');
  });
});

describe('excel refresh_pivot_table', () => {
  const handler = () => mustGet(getExcelCommandHandler('refresh_pivot_table'), 'refresh_pivot_table');

  it('refreshes the named pivot table only', async () => {
    const { context, calls } = makeExcelPivotContext();
    mockOfficeApp('Excel', context);

    const result = await handler()({ name: 'Summary' });

    expect(result.success).toBe(true);
    expect(calls.refresh).toHaveBeenCalledTimes(1);
    expect(calls.refreshAll).not.toHaveBeenCalled();
  });

  it('refreshes every pivot table when no name is given', async () => {
    const { context, calls } = makeExcelPivotContext();
    mockOfficeApp('Excel', context);

    const result = await handler()({});

    expect(result.success).toBe(true);
    expect(calls.refreshAll).toHaveBeenCalledTimes(1);
    expect(calls.refresh).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PowerPoint — apply_layout / format_shape / delete_shape
// ---------------------------------------------------------------------------

function makePowerPointContext() {
  const layout = { id: 'layout-2', name: 'Title and Content' };
  const shape = {
    id: 'shape-42',
    name: 'Title 1',
    fill: { setSolidColor: vi.fn() },
    lineFormat: { color: '', weight: 0 },
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    delete: vi.fn(),
  };
  const slide = {
    shapes: { items: [shape], load: vi.fn() },
    applyLayout: vi.fn(),
  };
  const context = {
    presentation: {
      slides: { items: [slide], load: vi.fn(), getItemAt: (index: number) => [slide][index]! },
      slideMasters: {
        items: [
          {
            layouts: {
              items: [{ id: 'layout-1', name: 'Title Slide' }, layout],
              load: vi.fn(),
            },
          },
        ],
        load: vi.fn(),
      },
    },
    sync: vi.fn(async () => {}),
  };
  return { context, slide, shape, layout };
}

describe('powerpoint apply_layout', () => {
  const handler = () => mustGet(getPowerpointCommandHandler('apply_layout'), 'apply_layout');

  it('applies the layout resolved case-insensitively by name', async () => {
    const { context, slide, layout } = makePowerPointContext();
    mockOfficeApp('PowerPoint', context);

    const result = await handler()({ slideIndex: 1, layout: 'title AND content' });

    expect(result.success).toBe(true);
    expect(slide.applyLayout).toHaveBeenCalledWith(layout);
  });

  it('lists available layouts when the requested one does not exist', async () => {
    const { context } = makePowerPointContext();
    mockOfficeApp('PowerPoint', context);

    const result = await handler()({ slideIndex: 1, layout: 'Fancy' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not found');
      expect(result.error).toContain('Title Slide');
      expect(result.error).toContain('Title and Content');
    }
  });

  it('rejects an out-of-range slide index', async () => {
    const { context } = makePowerPointContext();
    mockOfficeApp('PowerPoint', context);

    const result = await handler()({ slideIndex: 9, layout: 'Title Slide' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('out of range');
  });
});

describe('powerpoint format_shape', () => {
  const handler = () => mustGet(getPowerpointCommandHandler('format_shape'), 'format_shape');

  it('applies fill, size, and rename to the shape addressed by ID', async () => {
    const { context, shape } = makePowerPointContext();
    mockOfficeApp('PowerPoint', context);

    const result = await handler()({
      slideIndex: 1,
      target: { type: 'shapeId', shapeId: 'shape-42' },
      formatting: { fillColor: '#4472C4', width: 400, name: 'Hero' },
    });

    expect(result.success).toBe(true);
    expect(shape.fill.setSolidColor).toHaveBeenCalledWith('#4472C4');
    expect(shape.width).toBe(400);
    expect(shape.name).toBe('Hero');
  });

  it('fails cleanly when a shapeId target has no shapeId', async () => {
    const { context } = makePowerPointContext();
    mockOfficeApp('PowerPoint', context);

    const result = await handler()({
      slideIndex: 1,
      target: { type: 'shapeId' },
      formatting: { name: 'x' },
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('shapeId');
  });

  it('rejects an empty formatting object pre-flight', async () => {
    // No PowerPoint global installed — a clean INVALID_ARGUMENT proves the
    // check runs before any Office call.
    const result = await handler()({
      slideIndex: 1,
      target: { type: 'shapeId', shapeId: 'shape-42' },
      formatting: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('INVALID_ARGUMENT');
  });
});

describe('powerpoint delete_shape', () => {
  const handler = () => mustGet(getPowerpointCommandHandler('delete_shape'), 'delete_shape');

  it('deletes the shape matched by placeholder name, case-insensitive', async () => {
    const { context, shape } = makePowerPointContext();
    mockOfficeApp('PowerPoint', context);

    const result = await handler()({
      slideIndex: 1,
      target: { type: 'placeholder', placeholder: 'title' },
    });

    expect(result.success).toBe(true);
    expect(shape.delete).toHaveBeenCalledTimes(1);
    if (result.success) {
      expect((result.data as { deletedShapeId: string }).deletedShapeId).toBe('shape-42');
    }
  });

  it('fails cleanly when the shape does not exist', async () => {
    const { context } = makePowerPointContext();
    mockOfficeApp('PowerPoint', context);

    const result = await handler()({
      slideIndex: 1,
      target: { type: 'shapeId', shapeId: 'missing' },
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('not found');
  });
});
