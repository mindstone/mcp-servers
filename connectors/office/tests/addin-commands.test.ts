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
import * as executor from '../src/addin/officeExecutor.js';
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
  g.Office = { context: { requirements: { isSetSupported: vi.fn(() => true) } } };
  g[app] = {
    run: async (fn: (ctx: unknown) => Promise<unknown>) => await fn(context),
  };
}

afterEach(() => {
  delete g.Office;
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
  const selection = { text: '', load: vi.fn(), paragraphs: { items: [] as typeof paragraphs, load: vi.fn() } };
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
    load: vi.fn(),
    fill: { type: 'Solid', foregroundColor: '#112233', load: vi.fn(), setSolidColor: vi.fn() },
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


describe('executor result normalization', () => {
  it.each(['add_image', 'set_speaker_notes'])('promotes %s unsupported failure out of data', async (action) => {
    const slide = { shapes: {} };
    mockOfficeApp('PowerPoint', {
      presentation: { slides: { items: [slide], load: vi.fn(), getItemAt: () => slide } },
      sync: vi.fn(async () => {}),
    });
    const result = await mustGet(getPowerpointCommandHandler(action), action)({
      slideIndex: 1, source: { type: 'base64', base64: 'aGVsbG8=' },
      position: { left: 0, top: 0 }, notes: 'Notes',
    });
    expect(result).toMatchObject({ success: false, code: 'UNSUPPORTED_OPERATION' });
    expect(result).not.toHaveProperty('data');
  });

  it.each(['Word', 'Excel', 'PowerPoint'] as const)('normalizes callback results for %s', async (app) => {
    mockOfficeApp(app, {});
    const execute = { Word: executor.executeWordCommand, Excel: executor.executeExcelCommand, PowerPoint: executor.executePowerpointCommand }[app];
    expect(await execute(async () => ({ success: false, code: 'NO_SELECTION', error: 'Select text' })))
      .toEqual({ success: false, code: 'NO_SELECTION', error: 'Select text' });
    expect(await execute(async () => ({ success: true, changed: false })))
      .toEqual({ success: true, data: { changed: false } });
    expect(await execute(async () => ({ matches: [] }))).toEqual({ success: true, data: { matches: [] } });
    expect(await execute(async () => executor.fail('NO_SELECTION', 'Select text')))
      .toEqual({ success: false, code: 'NO_SELECTION', error: 'Select text' });
  });

  it.each(['ApiNotFound', 'NotImplemented'])('maps %s to unsupported', async (code) => {
    mockOfficeApp('Word', {});
    expect(await executor.executeWordCommand(async () => { throw { code, message: 'Missing API' }; }))
      .toMatchObject({ success: false, code: 'UNSUPPORTED_OPERATION' });
  });
});

describe('truthful command results', () => {
  it('uses coded failures for all handler validation', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const app of ['word', 'excel', 'powerpoint']) {
      expect(await readFile(new URL(`../src/addin/commands/${app}Commands.ts`, import.meta.url), 'utf8'))
        .not.toContain('throw new Error(');
    }
  });

  it.each(['insert_text', 'add_comment', 'format_text', 'apply_style'])('codes an out-of-range Word target in %s', async (action) => {
    const { context } = makeWordParagraphsContext(['Only paragraph']);
    mockOfficeApp('Word', context);
    expect(await mustGet(getWordCommandHandler(action), action)({
      text: 'New text', location: 'afterParagraph', paragraphIndex: 8, style: 'Quote',
      target: { type: action === 'add_comment' ? 'paragraph' : 'paragraphRange', paragraphIndex: 8, startParagraph: 8 },
      formatting: { bold: true },
    })).toMatchObject({ success: false, code: 'INVALID_ARGUMENT', error: expect.stringContaining('1 paragraphs') });
  });

  it.each(['format_text', 'add_comment', 'apply_style'])('requires selected text for %s', async (action) => {
    const { context, selection } = makeWordParagraphsContext(['p0']);
    Object.assign(selection, { text: '', load: vi.fn(), font: {}, insertComment: vi.fn() });
    mockOfficeApp('Word', context);
    expect(await mustGet(getWordCommandHandler(action), action)({
      text: 'Comment', style: 'Quote', target: { type: 'selection' }, formatting: { bold: true },
    })).toMatchObject({ success: false, code: 'NO_SELECTION' });
    expect(context.sync).toHaveBeenCalledTimes(1);
  });

  it('rejects a replacement with no matches', async () => {
    mockOfficeApp('Word', { document: { body: { search: () => ({ items: [], load: vi.fn() }) } }, sync: vi.fn() });
    expect(await mustGet(getWordCommandHandler('replace_text'), 'replace_text')({ searchText: 'Absent', replaceText: 'New' }))
      .toMatchObject({ success: false, code: 'ITEM_NOT_FOUND' });
  });

  it('codes a missing PowerPoint shape', async () => {
    const { context } = makePowerPointContext();
    mockOfficeApp('PowerPoint', context);
    expect(await mustGet(getPowerpointCommandHandler('delete_shape'), 'delete_shape')({ slideIndex: 1, target: { type: 'shapeId', shapeId: 'missing' } }))
      .toMatchObject({ success: false, code: 'ITEM_NOT_FOUND' });
  });

  it.each(['text', 'fillColor', 'lineColor', 'lineWidth'])('rejects unsupported shape %s before a writing sync', async (option) => {
    const { context, slide } = makePowerPointContext();
    const add = vi.fn();
    Object.assign(slide.shapes, { addGeometricShape: add });
    mockOfficeApp('PowerPoint', context);
    Object.assign(g.PowerPoint as object, { GeometricShapeType: { rectangle: 'Rectangle' } });
    g.Office = { context: { requirements: { isSetSupported: vi.fn(() => false) } } };
    expect(await mustGet(getPowerpointCommandHandler('add_shape'), 'add_shape')({
      slideIndex: 1, shapeType: 'rectangle', position: { left: 0, top: 0 }, [option]: option === 'lineWidth' ? 2 : 'value',
    })).toMatchObject({ success: false, code: 'UNSUPPORTED_OPERATION' });
    expect(add).not.toHaveBeenCalled();
    expect(context.sync).toHaveBeenCalledTimes(1); // slides read only
  });

  it.each(['add_text_box', 'update_text'])('applies advertised alignment for %s', async (action) => {
    const { context, slide, shape } = makePowerPointContext();
    const paragraphFormat = { horizontalAlignment: 'Left' };
    Object.assign(shape, { textFrame: { load: vi.fn(), textRange: { text: '', font: {}, paragraphFormat } }, load: vi.fn() });
    Object.assign(slide.shapes, { addTextBox: () => shape });
    mockOfficeApp('PowerPoint', context);
    expect(await mustGet(getPowerpointCommandHandler(action), action)({
      slideIndex: 1, text: 'New', position: { left: 0, top: 0 }, target: { type: 'shapeId', shapeId: shape.id }, formatting: { alignment: 'center' },
    })).toMatchObject({ success: true });
    expect(paragraphFormat.horizontalAlignment).toBe('Center');
  });

  it.each(['add_text_box', 'update_text'])('preserves unavailable formatting errors at the %s sync', async (action) => {
    const { context, slide, shape } = makePowerPointContext();
    Object.assign(shape, { textFrame: { load: vi.fn(), textRange: { text: '', font: {} } }, load: vi.fn() });
    Object.assign(slide.shapes, { addTextBox: () => shape });
    const syncNumber = action === 'update_text' ? 4 : 2;
    context.sync.mockImplementation(async () => {
      if (context.sync.mock.calls.length === syncNumber) throw { code: 'ApiNotFound', message: 'Formatting unavailable' };
    });
    mockOfficeApp('PowerPoint', context);
    expect(await mustGet(getPowerpointCommandHandler(action), action)({
      slideIndex: 1, text: 'New', position: { left: 0, top: 0 }, target: { type: 'shapeId', shapeId: shape.id }, formatting: { bold: true },
    })).toMatchObject({ success: false, code: 'UNSUPPORTED_OPERATION' });
    expect(context.sync).toHaveBeenCalledTimes(syncNumber);
  });

  it.each(['table', 'range'])('rejects unknown %s filter columns without applying earlier filters', async (kind) => {
    const apply = vi.fn();
    const range = { values: [['Name', 'Count']], load: vi.fn(), getRow: () => range };
    const table = { getHeaderRowRange: () => range, columns: { getItemAt: () => ({ filter: { apply: apply } }) } };
    const sheet = { getRange: () => range, autoFilter: { apply } };
    const context = { workbook: { tables: { getItem: () => table }, worksheets: { getActiveWorksheet: () => sheet } }, sync: vi.fn() };
    mockOfficeApp('Excel', context);
    Object.assign(g.Excel as object, { FilterOn: { values: 'Values', custom: 'Custom' } });
    expect(await mustGet(getExcelCommandHandler('filter_table'), 'filter_table')({
      ...(kind === 'table' ? { tableName: 'Data' } : { range: 'A1:B5' }),
      filters: [{ column: 'Name', criteria: { type: 'values', values: ['Acme'] } }, { column: 'Missing', criteria: { type: 'values', values: [] } }],
    })).toMatchObject({ success: false, code: 'ITEM_NOT_FOUND', error: expect.stringContaining('Name, Count') });
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies range filters with their actual criteria', async () => {
    const apply = vi.fn();
    const range = { values: [['Name', 'Count']], load: vi.fn(), getRow: () => range };
    mockOfficeApp('Excel', { workbook: { worksheets: { getActiveWorksheet: () => ({ getRange: () => range, autoFilter: { apply } }) } }, sync: vi.fn() });
    Object.assign(g.Excel as object, { FilterOn: { values: 'Values', custom: 'Custom' } });
    expect(await mustGet(getExcelCommandHandler('filter_table'), 'filter_table')({ range: 'A1:B5', filters: [
      { column: 'Name', criteria: { type: 'values', values: ['Acme'] } },
      { column: 'Count', criteria: { type: 'condition', operator: 'greaterThan', value: 3 } },
    ] })).toMatchObject({ success: true });
    expect(apply).toHaveBeenCalledWith(range, 0, { filterOn: 'Values', values: ['Acme'] });
    expect(apply).toHaveBeenCalledWith(range, 1, { filterOn: 'Custom', criterion1: '>3' });
  });

  it.each(['placeholder', 'sync', 'missing placeholder'])('reports a created slide when its later %s fails', async (failure) => {
    const slide = { id: 'created-slide', load: vi.fn(), moveTo: vi.fn(), shapes: { items: [{ name: 'Title', textFrame: { textRange: { text: '' } } }], load: vi.fn() } };
    if (failure === 'placeholder') Object.defineProperty(slide.shapes.items[0]!, 'textFrame', { get: () => { throw new Error('No text API'); } });
    if (failure === 'missing placeholder') slide.shapes.items = [];
    const slides = { items: [] as typeof slide[], getItemAt: () => slide, load: vi.fn(), add: () => { slides.items.push(slide); } };
    const sync = vi.fn(async () => {});
    if (failure === 'sync') sync.mockImplementation(async () => { if (sync.mock.calls.length === 3) throw new Error('Write failed'); });
    mockOfficeApp('PowerPoint', { presentation: { slides }, sync });
    expect(await mustGet(getPowerpointCommandHandler('add_slide'), 'add_slide')({
      title: 'New title', ...(failure === 'sync' ? { position: 1 } : {}),
    })).toMatchObject({ success: false, code: 'PARTIAL', error: expect.stringContaining('created-slide') });
    expect(slides.items).toHaveLength(1);
    if (failure === 'sync') expect(sync).toHaveBeenCalledTimes(3);
  });
});

it.each([0, 2])('rejects an unavailable speaker-notes slide index %s', async (slideIndex) => {
  const { context } = makePowerPointContext();
  mockOfficeApp('PowerPoint', context);
  expect(await mustGet(getPowerpointCommandHandler('get_speaker_notes'), 'get_speaker_notes')({ slideIndex }))
    .toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
});

it('does not report a successful notes read when the notes API is missing', async () => {
  const { context } = makePowerPointContext();
  mockOfficeApp('PowerPoint', context);
  expect(await mustGet(getPowerpointCommandHandler('get_speaker_notes'), 'get_speaker_notes')({ slideIndex: 1 }))
    .toMatchObject({ success: false, code: 'UNSUPPORTED_OPERATION' });
});

it.each(['format_text', 'add_comment', 'apply_style'])('still completes %s on selected text', async (action) => {
  const { context, selection, paragraphs } = makeWordParagraphsContext(['Selected text']);
  selection.text = 'Selected text';
  selection.paragraphs.items = paragraphs;
  Object.assign(selection, { font: {}, insertComment: () => ({ id: 'comment-1', load: vi.fn() }) });
  mockOfficeApp('Word', context);
  expect(await mustGet(getWordCommandHandler(action), action)({
    text: 'Comment', style: 'Quote', target: { type: 'selection' }, formatting: { bold: true },
  })).toMatchObject({ success: true });
  expect(context.sync).toHaveBeenCalledTimes(2);
});

it('still applies all requested table filters', async () => {
  const apply = vi.fn();
  const table = {
    getHeaderRowRange: () => ({ values: [['Name', 'Count']], load: vi.fn() }),
    columns: { getItemAt: (index: number) => ({ filter: { apply: (criteria: unknown) => apply(index, criteria) } }) },
  };
  mockOfficeApp('Excel', { workbook: { tables: { getItem: () => table } }, sync: vi.fn() });
  Object.assign(g.Excel as object, { FilterOn: { values: 'Values', custom: 'Custom' } });
  expect(await mustGet(getExcelCommandHandler('filter_table'), 'filter_table')({ tableName: 'Data', filters: [
    { column: 'Name', criteria: { type: 'values', values: ['Acme'] } },
    { column: 'Count', criteria: { type: 'condition', operator: 'greaterThan', value: 3 } },
  ] })).toMatchObject({ success: true });
  expect(apply.mock.calls).toEqual([[0, { filterOn: 'Values', values: ['Acme'] }], [1, { filterOn: 'Custom', criterion1: '>3' }]]);
});

it('rejects an unknown sort header before applying any sort fields', async () => {
  const apply = vi.fn();
  const table = { getHeaderRowRange: () => ({ values: [['Name', 'Count']], load: vi.fn() }), sort: { apply } };
  mockOfficeApp('Excel', { workbook: { tables: { getItem: () => table } }, sync: vi.fn() });
  expect(await mustGet(getExcelCommandHandler('sort_range'), 'sort_range')({
    tableName: 'Data', sortFields: [{ column: 'Name' }, { column: 'Missing' }],
  })).toMatchObject({ success: false, code: 'ITEM_NOT_FOUND', error: expect.stringContaining('Name, Count') });
  expect(apply).not.toHaveBeenCalled();
});

it('sorts AA relative to the start of a range beginning at Z', async () => {
  const apply = vi.fn();
  const range = { columnIndex: 25, columnCount: 3, load: vi.fn(), sort: { apply } };
  mockOfficeApp('Excel', { workbook: { worksheets: { getActiveWorksheet: () => ({ getRange: () => range }) } }, sync: vi.fn() });
  expect(await mustGet(getExcelCommandHandler('sort_range'), 'sort_range')({
    range: 'Z2:AB5', sortFields: [{ column: 'AA', ascending: false }],
  })).toMatchObject({ success: true });
  expect(apply).toHaveBeenCalledWith([{ key: 1, ascending: false }]);
});

it('rejects an unknown shape type without creating a rectangle', async () => {
  const { context, slide, shape } = makePowerPointContext();
  const addGeometricShape = vi.fn(() => ({ ...shape, load: vi.fn() }));
  Object.assign(slide.shapes, { addGeometricShape });
  mockOfficeApp('PowerPoint', context);
  Object.assign(g.PowerPoint as object, { GeometricShapeType: { rectangle: 'Rectangle' } });
  expect(await mustGet(getPowerpointCommandHandler('add_shape'), 'add_shape')({
    slideIndex: 1, shapeType: 'callout1', position: { left: 0, top: 0 },
  })).toMatchObject({ success: false, code: 'INVALID_ARGUMENT', error: expect.stringContaining('rectangle') });
  expect(addGeometricShape).not.toHaveBeenCalled();
});

it.each([
  ['greaterThan', '>'], ['greaterThanOrEqual', '>='], ['lessThan', '<'],
  ['lessThanOrEqual', '<='], ['equals', '='], ['notEqual', '<>'],
  ['>', '>'], ['>=', '>='], ['<', '<'], ['<=', '<='], ['=', '='], ['<>', '<>'],
])('translates filter operator %s to %s', async (operator, symbol) => {
  const apply = vi.fn();
  const table = {
    getHeaderRowRange: () => ({ values: [['Count']], load: vi.fn() }),
    columns: { getItemAt: () => ({ filter: { apply } }) },
  };
  mockOfficeApp('Excel', { workbook: { tables: { getItem: () => table } }, sync: vi.fn() });
  Object.assign(g.Excel as object, { FilterOn: { custom: 'Custom' } });
  expect(await mustGet(getExcelCommandHandler('filter_table'), 'filter_table')({ tableName: 'Data', filters: [
    { column: 'Count', criteria: { type: 'condition', operator, value: 100 } },
  ] })).toMatchObject({ success: true });
  expect(apply).toHaveBeenCalledWith({ filterOn: 'Custom', criterion1: `${symbol}100` });
});

it.each(['table', 'range'])('rejects an unknown %s filter operator before applying any filters', async (kind) => {
  const apply = vi.fn();
  const range = { values: [['Count']], load: vi.fn(), getRow: () => range };
  const table = { getHeaderRowRange: () => range, columns: { getItemAt: () => ({ filter: { apply } }) } };
  const sheet = { getRange: () => range, autoFilter: { apply } };
  mockOfficeApp('Excel', { workbook: { tables: { getItem: () => table }, worksheets: { getActiveWorksheet: () => sheet } }, sync: vi.fn() });
  Object.assign(g.Excel as object, { FilterOn: { values: 'Values', custom: 'Custom' } });
  expect(await mustGet(getExcelCommandHandler('filter_table'), 'filter_table')({
    ...(kind === 'table' ? { tableName: 'Data' } : { range: 'A1:A5' }),
    filters: [
      { column: 'Count', criteria: { type: 'values', values: ['3'] } },
      { column: 'Count', criteria: { type: 'condition', operator: 'approximately', value: 3 } },
    ],
  })).toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
  expect(apply).not.toHaveBeenCalled();
});

it.each(['A', 'AC', '1', 'A1'])('rejects invalid or out-of-range sort column %s before sorting', async (column) => {
  const apply = vi.fn();
  const range = { columnIndex: 25, columnCount: 3, load: vi.fn(), sort: { apply } };
  mockOfficeApp('Excel', { workbook: { worksheets: { getActiveWorksheet: () => ({ getRange: () => range }) } }, sync: vi.fn() });
  expect(await mustGet(getExcelCommandHandler('sort_range'), 'sort_range')({ range: 'Z2:AB5', sortFields: [{ column }] }))
    .toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
  expect(apply).not.toHaveBeenCalled();
});

it.each(['add_text_box', 'add_shape'])('checks API support before %s creates a formatted shape', async (action) => {
  const { context, slide } = makePowerPointContext();
  const add = vi.fn();
  Object.assign(slide.shapes, { addTextBox: add, addGeometricShape: add });
  mockOfficeApp('PowerPoint', context);
  Object.assign(g.PowerPoint as object, { GeometricShapeType: { rectangle: 'Rectangle' } });
  const isSetSupported = vi.fn(() => false);
  g.Office = { context: { requirements: { isSetSupported } } };
  expect(await mustGet(getPowerpointCommandHandler(action), action)({
    slideIndex: 1, shapeType: 'rectangle', text: 'New', position: { left: 0, top: 0 }, formatting: { alignment: 'center' },
  })).toMatchObject({ success: false, code: 'UNSUPPORTED_OPERATION' });
  expect(isSetSupported).toHaveBeenCalledWith('PowerPointApi', '1.4');
  expect(add).not.toHaveBeenCalled();
  expect(context.sync).toHaveBeenCalledTimes(1);
});

function makeNotesContext() {
  const textRange = { text: 'Existing notes' };
  const textFrame = { textRange, load: vi.fn() };
  const shapes = { items: [{ name: 'Notes Body', textFrame }], load: vi.fn() };
  const slide = { notesSlide: { shapes, load: vi.fn() } };
  const context = {
    presentation: { slides: { items: [slide], getItemAt: () => slide, load: vi.fn() } },
    sync: vi.fn(async () => {}),
  };
  return { context, textRange, shapes };
}

it.each([
  ['get_speaker_notes', 2, 'AccessDenied', 'READ_ONLY'],
  ['get_speaker_notes', 3, 'GeneralException', 'GENERAL_EXCEPTION'],
  ['set_speaker_notes', 2, 'GeneralException', 'GENERAL_EXCEPTION'],
  ['set_speaker_notes', 4, 'AccessDenied', 'READ_ONLY'],
  ['set_speaker_notes', 4, 'ApiNotFound', 'UNSUPPORTED_OPERATION'],
] as const)('preserves %s sync %s error %s as %s', async (action, syncNumber, code, expected) => {
  const { context } = makeNotesContext();
  context.sync.mockImplementation(async () => { if (context.sync.mock.calls.length === syncNumber) throw { code, message: 'Office error' }; });
  mockOfficeApp('PowerPoint', context);
  expect(await mustGet(getPowerpointCommandHandler(action), action)({ slideIndex: 1, notes: 'New' }))
    .toMatchObject({ success: false, code: expected });
});

it('retains the coded missing notes placeholder failure', async () => {
  const { context, shapes } = makeNotesContext();
  shapes.items = [];
  mockOfficeApp('PowerPoint', context);
  expect(await mustGet(getPowerpointCommandHandler('set_speaker_notes'), 'set_speaker_notes')({ slideIndex: 1, notes: 'New' }))
    .toMatchObject({ success: false, code: 'ITEM_NOT_FOUND' });
  expect(context.sync).toHaveBeenCalledTimes(3);
});

it.each([
  ['GeneralException', 'GENERAL_EXCEPTION'],
  ['AccessDenied', 'READ_ONLY'],
  ['ApiNotFound', 'UNSUPPORTED_OPERATION'],
] as const)('reports a speaker-notes text-load %s failure through the formatter', async (code, expected) => {
  const { context } = makeNotesContext();
  context.sync.mockImplementation(async () => {
    if (context.sync.mock.calls.length === 4) throw { code, message: 'Office error' };
  });
  mockOfficeApp('PowerPoint', context);
  const result = await mustGet(getPowerpointCommandHandler('get_speaker_notes'), 'get_speaker_notes')({ slideIndex: 1 });
  expect(result).toMatchObject({ success: false, code: expected });
  const { __test: { toMcpResult, stampUntrustedSource } } = await import('../src/index.js');
  const response = toMcpResult(stampUntrustedSource(result, 'powerpoint', 'get_speaker_notes'));
  expect(response.isError).toBe(true);
  expect(JSON.parse(response.content[0]!.text)).toMatchObject({ ok: false, error: { code: expected } });
});

it('does not write to an unrelated notes-page shape with a textFrame proxy', async () => {
  const { context, shapes, textRange } = makeNotesContext();
  shapes.items[0]!.name = 'Slide Image';
  mockOfficeApp('PowerPoint', context);
  expect(await mustGet(getPowerpointCommandHandler('set_speaker_notes'), 'set_speaker_notes')({ slideIndex: 1, notes: 'New' }))
    .toMatchObject({ success: false, code: 'ITEM_NOT_FOUND' });
  expect(textRange.text).toBe('Existing notes');
  expect(context.sync).toHaveBeenCalledTimes(3);
});

it('skips a second notes-page shape whose text sync throws InvalidArgument', async () => {
  const { context, shapes } = makeNotesContext();
  const imageTextFrame = { textRange: { text: '' }, load: vi.fn() };
  shapes.items.push({ name: 'Slide Image', textFrame: imageTextFrame });
  context.sync.mockImplementation(async () => {
    if (context.sync.mock.calls.length === 5) throw { code: 'InvalidArgument', message: 'Shape has no text frame' };
  });
  mockOfficeApp('PowerPoint', context);
  const result = await mustGet(getPowerpointCommandHandler('get_speaker_notes'), 'get_speaker_notes')({ slideIndex: 1 });
  expect(result)
    .toMatchObject({ success: true, data: { apiSupported: true, notes: [{ slideNumber: 1, notes: 'Existing notes' }] } });
  expect(imageTextFrame.load).toHaveBeenCalledWith('textRange/text');
  expect(context.sync).toHaveBeenCalledTimes(5);
  const { __test: { toMcpResult, stampUntrustedSource } } = await import('../src/index.js');
  const response = toMcpResult(stampUntrustedSource(result, 'powerpoint', 'get_speaker_notes'));
  expect(response.isError).toBeUndefined();
  expect(JSON.parse(response.content[0]!.text)).toMatchObject({
    ok: true, app: 'powerpoint', action: 'get_speaker_notes',
    data: { notes: [{ slideNumber: 1, notes: '<untrusted-content source="microsoft-office-powerpoint">Existing notes</untrusted-content>' }] },
  });
});

it('reads and writes supported speaker notes', async () => {
  const { context, textRange } = makeNotesContext();
  mockOfficeApp('PowerPoint', context);
  expect(await mustGet(getPowerpointCommandHandler('get_speaker_notes'), 'get_speaker_notes')({ slideIndex: 1 }))
    .toMatchObject({ success: true, data: { notes: [{ slideNumber: 1, notes: 'Existing notes' }] } });
  expect(await mustGet(getPowerpointCommandHandler('set_speaker_notes'), 'set_speaker_notes')({ slideIndex: 1, notes: 'New' }))
    .toMatchObject({ success: true });
  expect(textRange.text).toBe('New');
});

it.each(['missing', 'ApiNotFound', 'GeneralException'])('reports layout API failure %s instead of an empty list', async (failure) => {
  const { context } = makePowerPointContext();
  if (failure === 'missing') Object.assign(context.presentation, { slideMasters: undefined });
  else context.sync.mockImplementation(async () => { if (context.sync.mock.calls.length === 2) throw { code: failure, message: 'Layout read failed' }; });
  mockOfficeApp('PowerPoint', context);
  expect(await mustGet(getPowerpointCommandHandler('get_presentation_properties'), 'get_presentation_properties')({}))
    .toMatchObject({ success: false, code: failure === 'GeneralException' ? 'GENERAL_EXCEPTION' : 'UNSUPPORTED_OPERATION' });
});

it('aligns every paragraph in a Word paragraphRange', async () => {
  const paragraphs = [{ alignment: 'Left' }, { alignment: 'Left' }];
  const range = { font: {}, paragraphs: { items: paragraphs, load: vi.fn() } };
  const startRange = { expandTo: () => range };
  mockOfficeApp('Word', {
    document: { body: { paragraphs: { items: [{ getRange: () => startRange }, { getRange: () => ({}) }], load: vi.fn() } } },
    sync: vi.fn(),
  });
  Object.assign(g.Word as object, { Alignment: { left: 'Left', centered: 'Centered', right: 'Right', justified: 'Justified' } });
  expect(await mustGet(getWordCommandHandler('format_text'), 'format_text')({
    target: { type: 'paragraphRange', startParagraph: 0, endParagraph: 1 }, formatting: { alignment: 'center' },
  })).toMatchObject({ success: true });
  expect(paragraphs.map((paragraph) => paragraph.alignment)).toEqual(['Centered', 'Centered']);
});

// Record which syncs actually commit writes, rather than counting read syncs as undo steps.
function makeWorksheetInsertContext() {
  let pending: string[] = [];
  const batches: string[][] = [];
  const reference = { position: 2, load: vi.fn() };
  let position = 3;
  const sheet = {
    name: 'New sheet', load: vi.fn(),
    get position() { return position; },
    set position(value: number) { pending.push(`position=${value}`); position = value; },
  };
  const worksheets = {
    getItem: vi.fn(() => reference),
    add: vi.fn(() => { pending.push('add'); return sheet; }),
  };
  const context = {
    workbook: { worksheets },
    sync: vi.fn(async () => { batches.push(pending); pending = []; }),
  };
  return { context, worksheets, batches };
}

it('reads the reference position before adding and positioning a worksheet in one write', async () => {
  const { context, worksheets, batches } = makeWorksheetInsertContext();
  mockOfficeApp('Excel', context);
  expect(await mustGet(getExcelCommandHandler('add_worksheet'), 'add_worksheet')({ position: 'afterSheet', afterSheet: 'Reference' }))
    .toMatchObject({ success: true, data: { name: 'New sheet', position: 3 } });
  expect(worksheets.getItem).toHaveBeenCalledWith('Reference');
  expect(batches).toEqual([[], ['add', 'position=3']]);
});

it('rejects afterSheet without a reference before adding a worksheet', async () => {
  const { context, worksheets, batches } = makeWorksheetInsertContext();
  mockOfficeApp('Excel', context);
  expect(await mustGet(getExcelCommandHandler('add_worksheet'), 'add_worksheet')({ position: 'afterSheet' }))
    .toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
  expect(worksheets.add).not.toHaveBeenCalled();
  expect(batches.flat()).toEqual([]);
});

it.each(['insert_text', 'insert_table', 'insert_image'])(
  'rejects afterParagraph without paragraphIndex before writing in %s', async (action) => {
    const insert = vi.fn(() => ({}));
    const context = {
      document: { body: {
        insertParagraph: insert, insertTable: insert,
        paragraphs: { load: vi.fn(), items: [{ getRange: () => ({ insertInlinePictureFromBase64: insert }) }] },
      } },
      sync: vi.fn(),
    };
    mockOfficeApp('Word', context);
    Object.assign(g.Word as object, { InsertLocation: { end: 'End', after: 'After' } });
    expect(await mustGet(getWordCommandHandler(action), action)({
      text: 'Text', headers: ['Header'], rows: [], source: { type: 'base64', base64: 'aGVsbG8=' }, location: 'afterParagraph',
    })).toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
    expect(insert).not.toHaveBeenCalled();
  },
);

it.each(['format_text', 'apply_style'])(
  'rejects paragraphRange without startParagraph before writing in %s', async (action) => {
    const { context, paragraphs } = makeWordParagraphsContext(['Text']);
    const range = { font: {} };
    Object.assign(paragraphs[0]!, { getRange: () => ({ expandTo: () => range }) });
    mockOfficeApp('Word', context);
    expect(await mustGet(getWordCommandHandler(action), action)({
      style: 'Quote', formatting: { bold: true }, target: { type: 'paragraphRange' },
    })).toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
    expect(paragraphs[0]!.style).toBe('');
    expect(range.font).toEqual({});
    expect(context.sync).not.toHaveBeenCalled();
  },
);

it('rejects a specific tracked-change target without changeIds before writing', async () => {
  const accept = vi.fn();
  const context = {
    document: { body: { getTrackedChanges: () => ({ load: vi.fn(), items: [{ accept }] }) } },
    sync: vi.fn(),
  };
  mockOfficeApp('Word', context);
  expect(await mustGet(getWordCommandHandler('accept_reject_changes'), 'accept_reject_changes')({
    action: 'accept', target: { type: 'specific' },
  })).toMatchObject({ success: false, code: 'INVALID_ARGUMENT' });
  expect(accept).not.toHaveBeenCalled();
});

it.each(['accept', 'reject'])('rejects unmatched tracked-change IDs before any %s', async (action) => {
  const accept = vi.fn();
  const reject = vi.fn();
  const change = { author: 'Example Author', text: 'Edit', type: 'Added', accept, reject };
  const context = {
    document: { body: { getTrackedChanges: () => ({ load: vi.fn(), items: [change] }) } },
    sync: vi.fn(),
  };
  mockOfficeApp('Word', context);
  const handler = mustGet(getWordCommandHandler('accept_reject_changes'), 'accept_reject_changes');
  for (const changeIds of [['missing-one', 'missing-two'], ['0::Example Author::::Added::Edit', 'missing-one', 'missing-two']]) {
    const result = await handler({ action, target: { type: 'specific', changeIds } });
    expect(result).toMatchObject({ success: false, code: 'ITEM_NOT_FOUND' });
    if (!result.success) {
      expect(result.error).toContain('missing-one');
      expect(result.error).toContain('missing-two');
      expect(result.error).not.toContain('0::Example Author::::Added::Edit');
    }
    expect(accept).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  }
  expect(await handler({ action, target: { type: 'specific', changeIds: ['0::Example Author::::Added::Edit'] } }))
    .toMatchObject({ success: true, data: { processedCount: 1 } });
  expect(action === 'accept' ? accept : reject).toHaveBeenCalledOnce();
});

function makeWordInsertContext(originalStyle = 'Normal') {
  const batches: string[][] = [];
  let pending: string[] = [];
  interface InsertRange {
    text: string;
    font: { bold?: boolean; italic?: boolean };
    style?: string;
    paragraphs: { getFirst(): { style: string }; getLast(): { style: string } };
    insertText(value: string, location: string): InsertRange;
  }
  const paragraphs: Array<{ style: string; runs: InsertRange[] }> = [];
  const write = (value: string) => { pending.push(value); };
  const insertParagraph = (text: string, location: string, inheritedStyle = originalStyle) => {
    write(`paragraph:${location}`);
    const runs: InsertRange[] = [];
    let paragraphStyle = inheritedStyle;
    const paragraph = {
      get style() { return paragraphStyle; },
      set style(value: string) { write(`style:${value}`); paragraphStyle = value; },
      runs,
      insertText: (value: string, _location: string): InsertRange => {
        write(`text:${value}`);
        if (value === '\n') {
          const next = insertParagraph('', 'After', paragraph.style);
          let runStyle: string | undefined;
          // The break belongs to this paragraph; insertion at its end reaches the next.
          return {
            text: value, font: {}, paragraphs: { getFirst: () => paragraph, getLast: () => paragraph },
            get style() { return runStyle; },
            set style(value) { write(`run-style:${value}`); runStyle = value; },
            insertText: next.insertText,
          };
        }
        const previous = runs.at(-1);
        // New text inherits direct formatting already applied at the insertion point.
        const font = { ...previous?.font };
        let runStyle: string | undefined;
        const run: InsertRange = {
          text: value, font: new Proxy(font, {
            set(target, key, value: boolean) {
              write(`font:${String(key)}=${value}`);
              Reflect.set(target, key, value);
              return true;
            },
          }),
          paragraphs: { getFirst: () => paragraph, getLast: () => paragraph },
          insertText: (value, location) => {
            if (location === 'End') run.text += value;
            else expect(location).toBe('After');
            return paragraph.insertText(value, location);
          },
          get style() { return runStyle; },
          set style(value) { write(`run-style:${value}`); runStyle = value; },
        };
        runs.push(run);
        return run;
      },
      search: () => ({ items: [{ font: {} }], load: vi.fn() }),
      getRange: () => ({ insertParagraph }),
      insertParagraph,
    };
    if (text) paragraph.insertText(text, 'End');
    if (location === 'Start') paragraphs.unshift(paragraph); else paragraphs.push(paragraph);
    return paragraph;
  };
  const selectionRange = {
    insertText: () => {
      const paragraph = insertParagraph('', 'Replace');
      return { text: '', font: {}, paragraphs: { getFirst: () => paragraph, getLast: () => paragraph }, insertText: paragraph.insertText };
    },
  };
  const context = {
    document: {
      body: { insertParagraph, paragraphs: { items: [{ insertParagraph, getRange: () => ({ insertParagraph }) }], load: vi.fn() } },
      getSelection: () => selectionRange,
    },
    sync: vi.fn(async () => { batches.push(pending); pending = []; }),
  };
  return { context, batches, paragraphs, selectionRange };
}

describe('one Word insert undo step', () => {
  it.each(['end', 'start', 'afterParagraph', 'beforeParagraph', 'replaceSelection'])(
    'inserts all lines before styles and marks at %s', async (location) => {
      const { context, batches } = makeWordInsertContext();
      mockOfficeApp('Word', context);
      Object.assign(g.Word as object, { InsertLocation: { start: 'Start', end: 'End', after: 'After', before: 'Before', replace: 'Replace' } });
      expect(await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({
        text: '# Intro **bold**\n## Second *italic*', location, paragraphIndex: 0,
      })).toMatchObject({ success: true });
      expect(batches.filter(batch => batch.length)).toHaveLength(1);
      expect(batches.slice(0, -1).every(batch => batch.length === 0)).toBe(true);
      const writes = batches.flat();
      const lastInsert = writes.findLastIndex(event => event.startsWith('text:') || event.startsWith('paragraph:'));
      const firstStyle = writes.findIndex(event => event.startsWith('style:'));
      const lastStyle = writes.findLastIndex(event => event.startsWith('style:'));
      const firstMark = writes.findIndex(event => event.startsWith('font:'));
      expect(firstStyle).toBeGreaterThan(lastInsert);
      expect(firstMark).toBeGreaterThan(lastStyle);
      expect(writes.filter(event => event.startsWith('font:')).sort()).toEqual(['font:bold=true', 'font:italic=true']);
      if (location === 'replaceSelection') expect(writes).toContain('text:\n');
    },
  );

  it.each(['end', 'start', 'afterParagraph', 'beforeParagraph', 'replaceSelection'])(
    'styles a single paragraph before applying whole-line marks at %s', async (location) => {
      const { context, batches } = makeWordInsertContext();
      mockOfficeApp('Word', context);
      Object.assign(g.Word as object, { InsertLocation: { start: 'Start', end: 'End', after: 'After', before: 'Before', replace: 'Replace' } });
      expect(await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({
        text: '***Whole line***', style: 'Quote', location, paragraphIndex: 0,
      })).toMatchObject({ success: true });
      expect(batches.filter(batch => batch.length)).toHaveLength(1);
      expect(batches.flat().filter(event => !event.startsWith('paragraph:')))
        .toEqual(['text:Whole line', 'style:Quote', 'font:bold=true', 'font:italic=true']);
    },
  );

  it.each(['end', 'start', 'afterParagraph', 'beforeParagraph', 'replaceSelection'])(
    'queues bold and italic runs before one writing sync at %s', async (location) => {
      const { context, batches, paragraphs } = makeWordInsertContext();
      mockOfficeApp('Word', context);
      Object.assign(g.Word as object, { InsertLocation: { start: 'Start', end: 'End', after: 'After', before: 'Before', replace: 'Replace' } });
      const result = await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({
        text: '# same **same** *slant*\nSecond **bold**', location, paragraphIndex: 0,
      });
      expect(result.success).toBe(true);
      expect(batches.filter(batch => batch.length > 0)).toHaveLength(1);
      expect(batches.slice(0, -1).every(batch => batch.length === 0)).toBe(true);
      expect(context.sync).toHaveBeenCalledTimes(['afterParagraph', 'beforeParagraph'].includes(location) ? 2 : 1);
      const first = paragraphs.find(p => p.runs.map(r => r.text).join('') === 'same same slant');
      expect(first).toBeDefined();
      expect(first!.style).toBe('Heading 1');
      expect(first!.runs.map(r => [r.text, r.font.bold, r.font.italic])).toEqual([
        ['same ', undefined, undefined], ['same', true, undefined], [' ', undefined, undefined], ['slant', undefined, true],
      ]);
      expect(paragraphs.flatMap(p => p.runs).every(run => run.style === undefined)).toBe(true);
      expect(paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['same same slant', 'Second bold']);
    },
  );

  it.each(['Quote', 'Heading 4'])('leaves plain runs free of direct bold and italic with style %s', async (style) => {
    const { context, paragraphs, batches } = makeWordInsertContext();
    mockOfficeApp('Word', context);
    Object.assign(g.Word as object, { InsertLocation: { end: 'End', after: 'After' } });
    expect(await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({ text: 'Plain text', style }))
      .toMatchObject({ success: true });
    expect(paragraphs[0]!.style).toBe(style);
    expect(paragraphs[0]!.runs[0]!.font).toEqual({});
    expect(batches.filter(batch => batch.length)).toHaveLength(1);
  });

  it('inserts every part before applying direct formatting, without assigning false', async () => {
    const { context, paragraphs, batches } = makeWordInsertContext();
    mockOfficeApp('Word', context);
    Object.assign(g.Word as object, { InsertLocation: { end: 'End', after: 'After' } });
    expect(await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({ text: '**Bold** plain *italic* plain ***both*** plain' }))
      .toMatchObject({ success: true });
    expect(paragraphs[0]!.runs.map(run => run.font)).toEqual([
      { bold: true }, {}, { italic: true }, {},
      { bold: true, italic: true }, {},
    ]);
    expect(batches.flat().some(event => event.endsWith('=false'))).toBe(false);
    const writes = batches.flat();
    expect(writes.findIndex(event => event.startsWith('font:')))
      .toBeGreaterThan(writes.findLastIndex(event => event.startsWith('text:')));
  });

  it.each(['end', 'start', 'afterParagraph', 'beforeParagraph', 'replaceSelection'])(
    'puts the heading style on the paragraph and no run at %s', async (location) => {
      const { context, paragraphs, batches } = makeWordInsertContext();
      mockOfficeApp('Word', context);
      Object.assign(g.Word as object, { InsertLocation: { start: 'Start', end: 'End', after: 'After', before: 'Before', replace: 'Replace' } });
      expect(await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({ text: '# Plan for **Q3**', location, paragraphIndex: 0 }))
        .toMatchObject({ success: true });
      expect(paragraphs[0]!.style).toBe('Heading 1');
      expect(paragraphs[0]!.runs.map(run => [run.text, run.style, run.font]))
        .toEqual([['Plan for ', undefined, {}], ['Q3', undefined, { bold: true }]]);
      expect(batches.filter(batch => batch.length)).toHaveLength(1);
    },
  );

  it('keeps the Quote baseline after inline emphasis', async () => {
    const { context, paragraphs, batches } = makeWordInsertContext();
    mockOfficeApp('Word', context);
    Object.assign(g.Word as object, { InsertLocation: { end: 'End', after: 'After' } });
    expect(await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({ text: '*Emphasis* remainder', style: 'Quote' }))
      .toMatchObject({ success: true });
    expect(paragraphs[0]!.style).toBe('Quote');
    expect(paragraphs[0]!.runs.map(run => [run.style, run.font]))
      .toEqual([[undefined, { italic: true }], [undefined, {}]]);
    expect(batches.flat().some(event => event.endsWith('=false'))).toBe(false);
  });

  it('keeps adjacent bold and italic parts independent', async () => {
    const { context, paragraphs } = makeWordInsertContext();
    mockOfficeApp('Word', context);
    Object.assign(g.Word as object, { InsertLocation: { end: 'End', after: 'After' } });
    expect(await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({ text: '**a***b*' }))
      .toMatchObject({ success: true });
    expect(paragraphs[0]!.runs.map(run => [run.text, run.font]))
      .toEqual([['a', { bold: true }], ['b', { italic: true }]]);
  });

  it('applies a replacement heading to the text after the paragraph break', async () => {
    const { context, paragraphs, batches } = makeWordInsertContext();
    mockOfficeApp('Word', context);
    Object.assign(g.Word as object, { InsertLocation: { end: 'End', after: 'After', replace: 'Replace' } });
    expect(await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({ text: 'Intro\n# Heading', location: 'replaceSelection' }))
      .toMatchObject({ success: true });
    expect(paragraphs.map(p => ({ text: p.runs.map(r => r.text).join(''), style: p.style })))
      .toEqual([{ text: 'Intro', style: 'Normal' }, { text: 'Heading', style: 'Heading 1' }]);
    expect(batches.filter(batch => batch.length)).toHaveLength(1);
  });

  it.each(['Normal', 'Quote'])('keeps the original %s style after a replacement heading', async (originalStyle) => {
    const { context, paragraphs, batches } = makeWordInsertContext(originalStyle);
    mockOfficeApp('Word', context);
    Object.assign(g.Word as object, { InsertLocation: { end: 'End', after: 'After', replace: 'Replace' } });
    expect(await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({ text: '# Title\nBody', location: 'replaceSelection' }))
      .toMatchObject({ success: true });
    expect(paragraphs.map(p => p.style)).toEqual(['Heading 1', originalStyle]);
    expect(batches.filter(batch => batch.length)).toHaveLength(1);
    expect(context.sync).toHaveBeenCalledOnce();
  });

  it.each([
    ['5 * 3', '5 * 3'],
    ['a * b ** c', 'a  b * c'],
  ])('finishes inserting text containing an unmatched asterisk: %s', async (text, expected) => {
    const { context, paragraphs, batches } = makeWordInsertContext();
    mockOfficeApp('Word', context);
    Object.assign(g.Word as object, { InsertLocation: { end: 'End', after: 'After' } });
    expect(await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({ text }))
      .toMatchObject({ success: true });
    expect(paragraphs[0]!.runs.map(run => run.text).join('')).toBe(expected);
    expect(batches.filter(batch => batch.length)).toHaveLength(1);
  });
});

function makeAddSlideContext() {
  let pending: string[] = [];
  const batches: string[][] = [];
  const events: string[] = [];
  const textRange = { set text(value: string) { pending.push(`text:${value}`); } };
  const slide = {
    id: 'new-slide',
    moveTo: vi.fn(() => { events.push('move'); pending.push('move'); }),
    load: vi.fn(),
    shapes: { items: ['Title', 'Subtitle', 'Content'].map(name => ({ name, textFrame: { textRange } })), load: vi.fn(() => { events.push('shapes.load'); }) },
  };
  const slides = {
    items: [] as typeof slide[], load: vi.fn(),
    add: vi.fn(() => { events.push('add'); pending.push('add'); slides.items.push(slide); }),
    getItemAt: vi.fn((index: number) => { events.push(`get:${index}`); return slide; }),
  };
  const sync = vi.fn(async () => { events.push('sync'); batches.push(pending); pending = []; });
  return { context: { presentation: { slides }, sync }, slides, slide, batches, events };
}

describe('PowerPoint undo values and batching', () => {
  it.each([undefined, 'New title'])('adds and moves in one write, with a second only for text %s', async (title) => {
    const { context, batches, events } = makeAddSlideContext();
    mockOfficeApp('PowerPoint', context);
    expect(await mustGet(getPowerpointCommandHandler('add_slide'), 'add_slide')({ position: 1, title }))
      .toMatchObject({ success: true, data: { slideId: 'new-slide', slideNumber: 1 } });
    expect(batches.filter(batch => batch.length)).toEqual(title === undefined ? [['add', 'move']] : [['add', 'move'], ['text:New title']]);
    expect(events.slice(events.indexOf('add'), events.indexOf('add') + 4)).toEqual(['add', 'get:0', 'move', ...(title === undefined ? ['sync'] : ['shapes.load'])]);
  });

  it('rejects an unavailable move API before adding anything', async () => {
    const { context, slide, slides } = makeAddSlideContext();
    Object.assign(slide, { moveTo: undefined });
    // An existing slide proxy exposes the same API as the prospective new slide.
    slides.items.push(slide);
    mockOfficeApp('PowerPoint', context);
    expect(await mustGet(getPowerpointCommandHandler('add_slide'), 'add_slide')({ position: 1 }))
      .toMatchObject({ success: false, code: 'UNSUPPORTED_OPERATION' });
    expect(slides.add).not.toHaveBeenCalled();
  });

  it('returns previous text before replacing a shape', async () => {
    const { context, shape } = makePowerPointContext();
    Object.assign(shape, { textFrame: { load: vi.fn(), textRange: { text: 'Previous text' } } });
    mockOfficeApp('PowerPoint', context);
    expect(await mustGet(getPowerpointCommandHandler('update_text'), 'update_text')({ slideIndex: 1, target: { type: 'shapeId', shapeId: shape.id }, text: 'New' }))
      .toMatchObject({ success: true, data: { shapeId: shape.id, previousText: 'Previous text' } });
  });

  it('returns previous notes, including blank notes', async () => {
    const { context, textRange } = makeNotesContext();
    textRange.text = '';
    mockOfficeApp('PowerPoint', context);
    expect(await mustGet(getPowerpointCommandHandler('set_speaker_notes'), 'set_speaker_notes')({ slideIndex: 1, notes: 'New' }))
      .toMatchObject({ success: true, data: { previousNotes: '' } });
  });

  it('returns only the previous formatting properties that it changed', async () => {
    const { context, shape } = makePowerPointContext();
    Object.assign(shape, { load: vi.fn() });
    Object.assign(shape.fill, { type: 'Solid', foregroundColor: '#112233', load: vi.fn() });
    mockOfficeApp('PowerPoint', context);
    expect(await mustGet(getPowerpointCommandHandler('format_shape'), 'format_shape')({ slideIndex: 1, target: { type: 'shapeId', shapeId: shape.id }, formatting: { fillColor: '#ffffff', name: 'New name', left: 20 } }))
      .toMatchObject({ success: true, data: { previous: { fillColor: '#112233', name: 'Title 1', left: 0 } } });
  });

  it.each([null, ''])('omits absent previous fill and line colors (%s)', async (color) => {
    const { context, shape } = makePowerPointContext();
    Object.assign(shape.fill, { type: 'NoFill', foregroundColor: color });
    Object.assign(shape.lineFormat, { color });
    mockOfficeApp('PowerPoint', context);
    const result = await mustGet(getPowerpointCommandHandler('format_shape'), 'format_shape')({
      slideIndex: 1, target: { type: 'shapeId', shapeId: shape.id },
      formatting: { fillColor: '#ffffff', lineColor: '#ffffff', name: 'New' },
    });
    expect(result).toMatchObject({ success: true, data: { previousFillType: 'NoFill' } });
    if (result.success) expect((result.data as { previous: unknown }).previous).toEqual({ name: 'Title 1' });
  });
});

it('rejects unsupported slide movement requirements before creation', async () => {
  const { context, slides } = makeAddSlideContext();
  mockOfficeApp('PowerPoint', context);
  g.Office = { context: { requirements: { isSetSupported: vi.fn(() => false) } } };
  expect(await mustGet(getPowerpointCommandHandler('add_slide'), 'add_slide')({ position: 1 }))
    .toMatchObject({ success: false, code: 'UNSUPPORTED_OPERATION' });
  expect(slides.add).not.toHaveBeenCalled();
});

it('reports a previous non-solid fill without promising a solid-color inverse', async () => {
  const { context, shape } = makePowerPointContext();
  shape.fill.type = 'Gradient';
  mockOfficeApp('PowerPoint', context);
  expect(await mustGet(getPowerpointCommandHandler('format_shape'), 'format_shape')({
    slideIndex: 1, target: { type: 'shapeId', shapeId: shape.id }, formatting: { fillColor: '#ffffff' },
  })).toMatchObject({ success: true, data: { previousFillType: 'Gradient', previous: { fillColor: '#112233' } } });
});

it.each(['end', 'start', 'afterParagraph', 'beforeParagraph', 'replaceSelection'])(
  'preserves an explicit style over markdown headings at %s without an extra write', async (location) => {
    const { context, batches, paragraphs } = makeWordInsertContext();
    mockOfficeApp('Word', context);
    Object.assign(g.Word as object, { InsertLocation: { start: 'Start', end: 'End', after: 'After', before: 'Before', replace: 'Replace' } });
    expect(await mustGet(getWordCommandHandler('insert_text'), 'insert_text')({ text: '# **Bold**\n*Italic*', style: 'Quote', location, paragraphIndex: 0 }))
      .toMatchObject({ success: true });
    expect(batches.filter(batch => batch.length > 0)).toHaveLength(1);
    expect(paragraphs.map(p => p.style)).toEqual(['Quote', 'Quote']);
  },
);

it.each(['title', 'subtitle', 'body'])('adds slide %s in a second writing sync', async (placeholder) => {
  const { context, batches } = makeAddSlideContext();
  mockOfficeApp('PowerPoint', context);
  expect(await mustGet(getPowerpointCommandHandler('add_slide'), 'add_slide')({ [placeholder]: 'New text' }))
    .toMatchObject({ success: true });
  expect(batches.filter(batch => batch.length)).toEqual([['add'], ['text:New text']]);
});

it('adds an empty slide at the end with one writing sync', async () => {
  const { context, batches } = makeAddSlideContext();
  mockOfficeApp('PowerPoint', context);
  expect(await mustGet(getPowerpointCommandHandler('add_slide'), 'add_slide')({}))
    .toMatchObject({ success: true, data: { slideNumber: 1 } });
  expect(batches.filter(batch => batch.length)).toEqual([['add']]);
});

it('returns no untouched properties in previous shape formatting', async () => {
  const { context, shape } = makePowerPointContext();
  mockOfficeApp('PowerPoint', context);
  const result = await mustGet(getPowerpointCommandHandler('format_shape'), 'format_shape')({
    slideIndex: 1, target: { type: 'shapeId', shapeId: shape.id }, formatting: { name: 'New' },
  });
  expect(result.success).toBe(true);
  if (result.success) expect((result.data as { previous: unknown }).previous).toEqual({ name: 'Title 1' });
});
