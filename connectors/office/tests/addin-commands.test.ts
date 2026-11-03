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
    Object.assign(slide.shapes, { addGeometricShape: () => ({ load: vi.fn() }) });
    mockOfficeApp('PowerPoint', context);
    Object.assign(g.PowerPoint as object, { GeometricShapeType: { rectangle: 'Rectangle' } });
    expect(await mustGet(getPowerpointCommandHandler('add_shape'), 'add_shape')({
      slideIndex: 1, shapeType: 'rectangle', position: { left: 0, top: 0 }, [option]: option === 'lineWidth' ? 2 : 'value',
    })).toMatchObject({ success: false, code: 'UNSUPPORTED_OPERATION' });
    expect(context.sync).toHaveBeenCalledTimes(1); // slides read only
  });

  it.each(['add_text_box', 'update_text'])('applies advertised alignment for %s', async (action) => {
    const { context, slide, shape } = makePowerPointContext();
    const paragraphFormat = { horizontalAlignment: 'Left' };
    Object.assign(shape, { textFrame: { textRange: { text: '', font: {}, paragraphFormat } }, load: vi.fn() });
    Object.assign(slide.shapes, { addTextBox: () => shape });
    mockOfficeApp('PowerPoint', context);
    expect(await mustGet(getPowerpointCommandHandler(action), action)({
      slideIndex: 1, text: 'New', position: { left: 0, top: 0 }, target: { type: 'shapeId', shapeId: shape.id }, formatting: { alignment: 'center' },
    })).toMatchObject({ success: true });
    expect(paragraphFormat.horizontalAlignment).toBe('Center');
  });

  it.each(['add_text_box', 'update_text'])('rejects unavailable formatting for %s before writing', async (action) => {
    const { context, slide, shape } = makePowerPointContext();
    Object.assign(shape, { textFrame: { textRange: { text: '' } }, load: vi.fn() });
    Object.assign(slide.shapes, { addTextBox: () => shape });
    mockOfficeApp('PowerPoint', context);
    expect(await mustGet(getPowerpointCommandHandler(action), action)({
      slideIndex: 1, text: 'New', position: { left: 0, top: 0 }, target: { type: 'shapeId', shapeId: shape.id }, formatting: { bold: true },
    })).toMatchObject({ success: false, code: 'UNSUPPORTED_OPERATION' });
    expect(context.sync).toHaveBeenCalledTimes(action === 'update_text' ? 2 : 1);
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

  it.each(['move', 'placeholder', 'sync', 'missing placeholder'])('reports a created slide when its later %s fails', async (failure) => {
    const slide = { id: 'created-slide', moveTo: vi.fn(), shapes: { items: [{ name: 'Title' }], load: vi.fn() } };
    if (failure === 'move') slide.moveTo.mockImplementation(() => { throw new Error('No move API'); });
    if (failure === 'missing placeholder') slide.shapes.items = [];
    const slides = { items: [] as typeof slide[], load: vi.fn(), add: () => { slides.items.push(slide); } };
    const sync = vi.fn(async () => {});
    if (failure === 'sync') sync.mockImplementation(async () => { if (sync.mock.calls.length === 4) throw new Error('Write failed'); });
    mockOfficeApp('PowerPoint', { presentation: { slides }, sync });
    expect(await mustGet(getPowerpointCommandHandler('add_slide'), 'add_slide')({
      ...(failure === 'move' || failure === 'sync' ? { position: 1 } : { title: 'New title' }),
    })).toMatchObject({ success: false, code: 'PARTIAL', error: expect.stringContaining('created-slide') });
    expect(slides.items).toHaveLength(1);
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
  ['get_speaker_notes', 4, 'GeneralException', 'GENERAL_EXCEPTION'],
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
