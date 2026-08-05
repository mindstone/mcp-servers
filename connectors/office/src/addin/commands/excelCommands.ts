/**
 * Excel command handlers — maps sidecar command actions to Office.js Excel API calls.
 * Each handler receives arbitrary params and returns a structured CommandResult.
 * Runs in the Office WebView (browser context).
 *
 * Requires ExcelApi 1.1+ (most features), ExcelApi 1.6+ (conditional formatting),
 * ExcelApi 1.8+ (data validation), ExcelApi 1.10+ (comments).
 */

import { executeExcelCommand, type CommandResult } from '../officeExecutor.js';

export type ExcelCommandHandler = (params: Record<string, unknown>) => Promise<CommandResult>;

const excelCommands: Record<string, ExcelCommandHandler> = {
  read_range: readRange,
  write_range: writeRange,
  get_worksheets: getWorksheets,
  add_worksheet: addWorksheet,
  delete_worksheet: deleteWorksheet,
  read_table: readTable,
  create_table: createTable,
  set_formula: setFormula,
  get_formulas: getFormulas,
  create_chart: createChart,
  format_range: formatRange,
  add_conditional_formatting: addConditionalFormatting,
  sort_range: sortRange,
  filter_table: filterTable,
  get_named_ranges: getNamedRanges,
  insert_rows_columns: insertRowsColumns,
  delete_rows_columns: deleteRowsColumns,
  merge_cells: mergeCells,
  auto_fit: autoFit,
  add_data_validation: addDataValidation,
  get_comments: getComments,
  add_comment: addComment,
  get_pivot_tables: getPivotTables,
  create_pivot_table: createPivotTable,
  refresh_pivot_table: refreshPivotTable,
};

/**
 * Look up an Excel command handler by action name.
 * Returns null if the action is not recognized.
 */
export function getExcelCommandHandler(action: string): ExcelCommandHandler | null {
  return excelCommands[action] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get a worksheet by name or the active worksheet if no name is provided. */
function getWorksheet(context: Excel.RequestContext, worksheetName?: string): Excel.Worksheet {
  return worksheetName
    ? context.workbook.worksheets.getItem(worksheetName)
    : context.workbook.worksheets.getActiveWorksheet();
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

/**
 * read_range — Read cell values from a range.
 * Params:
 *   range       (string, required) — A1 notation or named range
 *   worksheet   (string, optional) — worksheet name
 *   hasHeaders  (boolean, default true) — treat first row as headers
 *   return_json (boolean, default false) — return as array of objects
 *   limit       (number, default 1000) — max rows to return
 */
async function readRange(params: Record<string, unknown>): Promise<CommandResult> {
  const rangeAddr = params['range'];
  if (typeof rangeAddr !== 'string' || rangeAddr.length === 0) {
    return { success: false, error: 'The "range" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;
  const hasHeaders = typeof params['hasHeaders'] === 'boolean' ? params['hasHeaders'] : true;
  const returnJson = typeof params['return_json'] === 'boolean' ? params['return_json'] : false;
  const limit = typeof params['limit'] === 'number' && params['limit'] > 0 ? params['limit'] : 1000;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const range = sheet.getRange(rangeAddr as string);
    range.load(['values', 'text', 'rowCount', 'columnCount']);
    await context.sync();

    const allValues: unknown[][] = range.values;
    const totalRows = allValues.length;

    if (hasHeaders && returnJson && totalRows > 0) {
      const headers = allValues[0] as string[];
      const dataRows = allValues.slice(1, 1 + limit);
      const jsonRows = dataRows.map((row) => {
        const obj: Record<string, unknown> = {};
        for (let c = 0; c < headers.length; c++) {
          obj[headers[c] ?? `Column${c + 1}`] = row[c];
        }
        return obj;
      });
      return { headers, rows: jsonRows, totalRows: totalRows - 1, returnedRows: jsonRows.length };
    }

    const cappedValues = allValues.slice(0, hasHeaders ? limit + 1 : limit);
    return {
      values: cappedValues,
      totalRows,
      returnedRows: cappedValues.length,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
    };
  });
}

/**
 * write_range — Write values to cells.
 * Params:
 *   range     (string, required) — starting cell in A1 notation
 *   values    (array of arrays, required) — 2D array of values
 *   worksheet (string, optional)
 */
async function writeRange(params: Record<string, unknown>): Promise<CommandResult> {
  const rangeAddr = params['range'];
  if (typeof rangeAddr !== 'string' || rangeAddr.length === 0) {
    return { success: false, error: 'The "range" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const values = params['values'];
  if (!Array.isArray(values) || values.length === 0) {
    return { success: false, error: 'The "values" parameter is required and must be a non-empty 2D array.', code: 'INVALID_ARGUMENT' };
  }

  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const rows = values as unknown[][];
    const rowCount = rows.length;
    const colCount = Math.max(...rows.map((r) => (r as unknown[]).length));

    // Expand range from starting cell to fit data dimensions
    const startRange = sheet.getRange(rangeAddr as string);
    const targetRange = startRange.getResizedRange(rowCount - 1, colCount - 1);

    // Pad rows to uniform column count
    const paddedValues = rows.map((row) => {
      const r = row as unknown[];
      const padded = [...r];
      while (padded.length < colCount) padded.push('');
      return padded;
    });

    targetRange.values = paddedValues;
    await context.sync();

    return { success: true, rowsWritten: rowCount, columnsWritten: colCount };
  });
}

/**
 * get_worksheets — List all worksheets in the workbook.
 */
async function getWorksheets(_params: Record<string, unknown>): Promise<CommandResult> {
  return executeExcelCommand(async (context) => {
    const sheets = context.workbook.worksheets;
    sheets.load(['name', 'position', 'visibility', 'id']);
    await context.sync();

    const result = [];
    for (const sheet of sheets.items) {
      // Get used range info
      const usedRange = sheet.getUsedRangeOrNullObject();
      usedRange.load(['address', 'rowCount', 'columnCount']);
      await context.sync();

      result.push({
        name: sheet.name,
        position: sheet.position,
        visibility: sheet.visibility,
        id: sheet.id,
        usedRange: usedRange.isNullObject
          ? null
          : {
              address: usedRange.address,
              rowCount: usedRange.rowCount,
              columnCount: usedRange.columnCount,
            },
      });
    }

    return { worksheetCount: result.length, worksheets: result };
  });
}

/**
 * add_worksheet — Add a new worksheet.
 * Params:
 *   name       (string, optional)
 *   position   ("end" | "start" | "afterSheet", default "end")
 *   afterSheet (string, optional) — sheet name for afterSheet position
 */
async function addWorksheet(params: Record<string, unknown>): Promise<CommandResult> {
  const name = typeof params['name'] === 'string' ? params['name'] : undefined;
  const position = typeof params['position'] === 'string' ? params['position'] : 'end';
  const afterSheet = typeof params['afterSheet'] === 'string' ? params['afterSheet'] : undefined;

  return executeExcelCommand(async (context) => {
    const newSheet = context.workbook.worksheets.add(name);
    newSheet.load(['name', 'position']);

    if (position === 'start') {
      newSheet.position = 0;
    } else if (position === 'afterSheet' && afterSheet) {
      const refSheet = context.workbook.worksheets.getItem(afterSheet);
      refSheet.load('position');
      await context.sync();
      newSheet.position = refSheet.position + 1;
    }
    // 'end' is the default behavior

    await context.sync();
    return { success: true, name: newSheet.name, position: newSheet.position };
  });
}

/**
 * delete_worksheet — Delete a worksheet by name.
 * Params:
 *   worksheet (string, required)
 */
async function deleteWorksheet(params: Record<string, unknown>): Promise<CommandResult> {
  const worksheetName = params['worksheet'];
  if (typeof worksheetName !== 'string' || worksheetName.length === 0) {
    return { success: false, error: 'The "worksheet" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  return executeExcelCommand(async (context) => {
    const sheet = context.workbook.worksheets.getItem(worksheetName as string);
    sheet.delete();
    await context.sync();
    return { success: true, deleted: worksheetName };
  });
}

/**
 * read_table — Read data from a named Excel table.
 * Params:
 *   tableName   (string, required)
 *   return_json (boolean, default true)
 *   limit       (number, default 1000)
 *   offset      (number, default 0)
 */
async function readTable(params: Record<string, unknown>): Promise<CommandResult> {
  const tableName = params['tableName'];
  if (typeof tableName !== 'string' || tableName.length === 0) {
    return { success: false, error: 'The "tableName" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const returnJson = typeof params['return_json'] === 'boolean' ? params['return_json'] : true;
  const limit = typeof params['limit'] === 'number' && params['limit'] > 0 ? params['limit'] : 1000;
  const offset = typeof params['offset'] === 'number' && params['offset'] >= 0 ? params['offset'] : 0;

  return executeExcelCommand(async (context) => {
    const table = context.workbook.tables.getItem(tableName as string);
    const headerRange = table.getHeaderRowRange();
    headerRange.load('values');
    const dataRange = table.getDataBodyRange();
    dataRange.load(['values', 'rowCount']);
    await context.sync();

    const headers = (headerRange.values[0] ?? []) as string[];
    const allRows = dataRange.values as unknown[][];
    const totalRows = allRows.length;
    const slicedRows = allRows.slice(offset, offset + limit);

    if (returnJson) {
      const jsonRows = slicedRows.map((row) => {
        const obj: Record<string, unknown> = {};
        for (let c = 0; c < headers.length; c++) {
          obj[headers[c] ?? `Column${c + 1}`] = row[c];
        }
        return obj;
      });
      return { headers, rows: jsonRows, totalRows, returnedRows: jsonRows.length, offset };
    }

    return { headers, rows: slicedRows, totalRows, returnedRows: slicedRows.length, offset };
  });
}

/**
 * create_table — Convert a range into a named Excel table.
 * Params:
 *   range     (string, required) — A1 notation including header row
 *   name      (string, optional)
 *   worksheet (string, optional)
 *   style     (string, optional) — table style name
 */
async function createTable(params: Record<string, unknown>): Promise<CommandResult> {
  const rangeAddr = params['range'];
  if (typeof rangeAddr !== 'string' || rangeAddr.length === 0) {
    return { success: false, error: 'The "range" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;
  const name = typeof params['name'] === 'string' ? params['name'] : undefined;
  const style = typeof params['style'] === 'string' ? params['style'] : undefined;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const table = sheet.tables.add(rangeAddr as string, true /* hasHeaders */);

    if (name) table.name = name;
    if (style) table.style = style;

    table.load(['name', 'id']);
    await context.sync();

    return { success: true, tableName: table.name, tableId: table.id };
  });
}

/**
 * set_formula — Set a formula in one or more cells.
 * Params:
 *   cell      (string, required) — A1 notation
 *   formula   (string, required) — formula including leading =
 *   worksheet (string, optional)
 *   fillDown  (number, optional) — rows to fill down
 */
async function setFormula(params: Record<string, unknown>): Promise<CommandResult> {
  const cell = params['cell'];
  if (typeof cell !== 'string' || cell.length === 0) {
    return { success: false, error: 'The "cell" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const formula = params['formula'];
  if (typeof formula !== 'string' || formula.length === 0) {
    return { success: false, error: 'The "formula" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;
  const fillDown = typeof params['fillDown'] === 'number' && params['fillDown'] > 0 ? params['fillDown'] : 0;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const range = sheet.getRange(cell as string);
    range.formulas = [[formula as string]];

    if (fillDown > 0) {
      const fillRange = range.getResizedRange(fillDown, 0);
      range.autoFill(fillRange.getAbsoluteResizedRange(fillDown + 1, 1), Excel.AutoFillType.fillDefault);
    }

    await context.sync();
    return { success: true, cell, formula };
  });
}

/**
 * get_formulas — Read formulas from a range.
 * Params:
 *   range     (string, required)
 *   worksheet (string, optional)
 */
async function getFormulas(params: Record<string, unknown>): Promise<CommandResult> {
  const rangeAddr = params['range'];
  if (typeof rangeAddr !== 'string' || rangeAddr.length === 0) {
    return { success: false, error: 'The "range" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const range = sheet.getRange(rangeAddr as string);
    range.load(['formulas', 'values', 'rowCount', 'columnCount']);
    await context.sync();

    return {
      formulas: range.formulas,
      values: range.values,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
    };
  });
}

/**
 * create_chart — Create a chart from data.
 * Params:
 *   dataRange         (string, required) — A1 notation
 *   chartType         (string, required) — bar, column, line, pie, area, scatter, doughnut, radar
 *   title             (string, optional)
 *   worksheet         (string, optional)
 *   position          (object, optional) — { left, top, width, height } in points
 *   seriesOrientation (string, default "columns")
 */
async function createChart(params: Record<string, unknown>): Promise<CommandResult> {
  const dataRange = params['dataRange'];
  if (typeof dataRange !== 'string' || dataRange.length === 0) {
    return { success: false, error: 'The "dataRange" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const chartTypeStr = params['chartType'];
  if (typeof chartTypeStr !== 'string') {
    return { success: false, error: 'The "chartType" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const chartTypeMap: Record<string, Excel.ChartType> = {
    bar: Excel.ChartType.barClustered,
    column: Excel.ChartType.columnClustered,
    line: Excel.ChartType.line,
    pie: Excel.ChartType.pie,
    area: Excel.ChartType.area,
    scatter: Excel.ChartType.xyscatter,
    doughnut: Excel.ChartType.doughnut,
    radar: Excel.ChartType.radar,
  };

  const chartType = chartTypeMap[chartTypeStr];
  if (chartType === undefined) {
    return { success: false, error: `Unsupported chart type: "${chartTypeStr}".`, code: 'INVALID_ARGUMENT' };
  }

  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;
  const title = typeof params['title'] === 'string' ? params['title'] : undefined;
  const position = params['position'] as { left?: number; top?: number; width?: number; height?: number } | undefined;
  const orientation = typeof params['seriesOrientation'] === 'string' ? params['seriesOrientation'] : 'columns';

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const range = sheet.getRange(dataRange as string);
    const chart = sheet.charts.add(
      chartType,
      range,
      orientation === 'rows' ? Excel.ChartSeriesBy.rows : Excel.ChartSeriesBy.columns,
    );

    if (title) chart.title.text = title;
    if (position?.left !== undefined) chart.left = position.left;
    if (position?.top !== undefined) chart.top = position.top;
    if (position?.width !== undefined) chart.width = position.width;
    if (position?.height !== undefined) chart.height = position.height;

    chart.load(['name', 'id']);
    await context.sync();

    return { success: true, chartName: chart.name, chartId: chart.id };
  });
}

/**
 * format_range — Apply formatting to a cell range.
 * Params:
 *   range      (string, required)
 *   worksheet  (string, optional)
 *   formatting (object, required) — font, fill, border, number format, alignment properties
 */
async function formatRange(params: Record<string, unknown>): Promise<CommandResult> {
  const rangeAddr = params['range'];
  if (typeof rangeAddr !== 'string' || rangeAddr.length === 0) {
    return { success: false, error: 'The "range" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const formatting = params['formatting'] as Record<string, unknown> | undefined;
  if (!formatting || typeof formatting !== 'object') {
    return { success: false, error: 'The "formatting" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const range = sheet.getRange(rangeAddr as string);

    // Font properties
    const font = range.format.font;
    if (typeof formatting['bold'] === 'boolean') font.bold = formatting['bold'];
    if (typeof formatting['italic'] === 'boolean') font.italic = formatting['italic'];
    if (typeof formatting['underline'] === 'boolean') {
      font.underline = formatting['underline']
        ? Excel.RangeUnderlineStyle.single
        : Excel.RangeUnderlineStyle.none;
    }
    if (typeof formatting['fontFamily'] === 'string') font.name = formatting['fontFamily'];
    if (typeof formatting['fontSize'] === 'number') font.size = formatting['fontSize'];
    if (typeof formatting['fontColor'] === 'string') font.color = formatting['fontColor'];

    // Fill
    if (typeof formatting['fillColor'] === 'string') {
      range.format.fill.color = formatting['fillColor'];
    }

    // Number format
    if (typeof formatting['numberFormat'] === 'string') {
      range.numberFormat = [[formatting['numberFormat']]];
    }

    // Alignment
    if (typeof formatting['horizontalAlignment'] === 'string') {
      const hAlignMap: Record<string, Excel.HorizontalAlignment> = {
        left: Excel.HorizontalAlignment.left,
        center: Excel.HorizontalAlignment.center,
        right: Excel.HorizontalAlignment.right,
        fill: Excel.HorizontalAlignment.fill,
      };
      const hAlign = hAlignMap[formatting['horizontalAlignment']];
      if (hAlign !== undefined) range.format.horizontalAlignment = hAlign;
    }

    if (typeof formatting['verticalAlignment'] === 'string') {
      const vAlignMap: Record<string, Excel.VerticalAlignment> = {
        top: Excel.VerticalAlignment.top,
        center: Excel.VerticalAlignment.center,
        bottom: Excel.VerticalAlignment.bottom,
      };
      const vAlign = vAlignMap[formatting['verticalAlignment']];
      if (vAlign !== undefined) range.format.verticalAlignment = vAlign;
    }

    if (typeof formatting['wrapText'] === 'boolean') {
      range.format.wrapText = formatting['wrapText'];
    }

    // Borders
    const borders = formatting['borders'] as { style?: string; color?: string; edges?: string[] } | undefined;
    if (borders) {
      const styleMap: Record<string, { style: Excel.BorderLineStyle; weight?: Excel.BorderWeight }> = {
        thin: { style: Excel.BorderLineStyle.continuous, weight: Excel.BorderWeight.thin },
        medium: { style: Excel.BorderLineStyle.continuous, weight: Excel.BorderWeight.medium },
        thick: { style: Excel.BorderLineStyle.continuous, weight: Excel.BorderWeight.thick },
        dashed: { style: Excel.BorderLineStyle.dash },
        dotted: { style: Excel.BorderLineStyle.dot },
      };
      const lineStyle =
        borders.style ? styleMap[borders.style] ?? styleMap['thin']! : styleMap['thin']!;
      const lineColor = borders.color ?? '#000000';
      const edges = borders.edges ?? ['top', 'bottom', 'left', 'right'];

      const borderIndexMap: Record<string, Excel.BorderIndex> = {
        top: Excel.BorderIndex.edgeTop,
        bottom: Excel.BorderIndex.edgeBottom,
        left: Excel.BorderIndex.edgeLeft,
        right: Excel.BorderIndex.edgeRight,
        insideHorizontal: Excel.BorderIndex.insideHorizontal,
        insideVertical: Excel.BorderIndex.insideVertical,
      };

      for (const edge of edges) {
        const borderIndex = borderIndexMap[edge];
        if (borderIndex !== undefined) {
          const border = range.format.borders.getItem(borderIndex);
          border.style = lineStyle.style;
          if (lineStyle.weight !== undefined) {
            border.weight = lineStyle.weight;
          }
          border.color = lineColor;
        }
      }
    }

    await context.sync();
    return { success: true };
  });
}

/**
 * add_conditional_formatting — Add conditional formatting rules.
 * Params:
 *   range     (string, required)
 *   worksheet (string, optional)
 *   rule      (object, required) — type, operator, values, format, colorScale
 */
async function addConditionalFormatting(params: Record<string, unknown>): Promise<CommandResult> {
  const rangeAddr = params['range'];
  if (typeof rangeAddr !== 'string' || rangeAddr.length === 0) {
    return { success: false, error: 'The "range" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const rule = params['rule'] as Record<string, unknown> | undefined;
  if (!rule || typeof rule !== 'object' || typeof rule['type'] !== 'string') {
    return { success: false, error: 'The "rule" parameter with a "type" field is required.', code: 'INVALID_ARGUMENT' };
  }

  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const range = sheet.getRange(rangeAddr as string);

    switch (rule['type']) {
      case 'cellValue': {
        const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.cellValue);
        const operatorMap: Record<string, Excel.ConditionalCellValueOperator> = {
          greaterThan: Excel.ConditionalCellValueOperator.greaterThan,
          lessThan: Excel.ConditionalCellValueOperator.lessThan,
          between: Excel.ConditionalCellValueOperator.between,
          equalTo: Excel.ConditionalCellValueOperator.equalTo,
          notEqualTo: Excel.ConditionalCellValueOperator.notEqualTo,
          greaterThanOrEqual: Excel.ConditionalCellValueOperator.greaterThanOrEqual,
          lessThanOrEqual: Excel.ConditionalCellValueOperator.lessThanOrEqual,
        };
        const operator = typeof rule['operator'] === 'string'
          ? operatorMap[rule['operator']] ?? Excel.ConditionalCellValueOperator.greaterThan
          : Excel.ConditionalCellValueOperator.greaterThan;
        const values = Array.isArray(rule['values']) ? rule['values'] : [];

        cf.cellValue.rule = {
          formula1: String(values[0] ?? '0'),
          formula2: values.length > 1 ? String(values[1]) : undefined,
          operator,
        };

        const format = rule['format'] as Record<string, unknown> | undefined;
        if (format) {
          if (typeof format['fontColor'] === 'string') cf.cellValue.format.font.color = format['fontColor'];
          if (typeof format['fillColor'] === 'string') cf.cellValue.format.fill.color = format['fillColor'];
          if (typeof format['bold'] === 'boolean') cf.cellValue.format.font.bold = format['bold'];
        }
        break;
      }

      case 'colorScale': {
        const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.colorScale);
        const colorScale = rule['colorScale'] as { minimum?: { color: string }; midpoint?: { color: string }; maximum?: { color: string } } | undefined;
        if (colorScale) {
          const criteria: Excel.ConditionalColorScaleCriteria = {
            minimum: { color: colorScale.minimum?.color ?? '#FFFFFF', type: Excel.ConditionalFormatColorCriterionType.lowestValue },
            maximum: { color: colorScale.maximum?.color ?? '#FF0000', type: Excel.ConditionalFormatColorCriterionType.highestValue },
          };
          if (colorScale.midpoint) {
            criteria.midpoint = {
              color: colorScale.midpoint.color,
              type: Excel.ConditionalFormatColorCriterionType.percentile,
              formula: '50',
            };
          }
          cf.colorScale.criteria = criteria;
        }
        break;
      }

      case 'dataBar': {
        range.conditionalFormats.add(Excel.ConditionalFormatType.dataBar);
        // Data bar uses automatic defaults — Excel auto-configures min/max
        break;
      }

      case 'iconSet': {
        range.conditionalFormats.add(Excel.ConditionalFormatType.iconSet);
        break;
      }

      case 'topBottom': {
        const cf = range.conditionalFormats.add(Excel.ConditionalFormatType.topBottom);
        const values = Array.isArray(rule['values']) ? rule['values'] : [10];
        cf.topBottom.rule = {
          rank: Number(values[0]) || 10,
          type: Excel.ConditionalTopBottomCriterionType.topItems,
        };
        const format = rule['format'] as Record<string, unknown> | undefined;
        if (format) {
          if (typeof format['fillColor'] === 'string') cf.topBottom.format.fill.color = format['fillColor'];
        }
        break;
      }

      default:
        throw new Error(`Unsupported conditional formatting type: "${rule['type'] as string}".`);
    }

    await context.sync();
    return { success: true };
  });
}

/**
 * sort_range — Sort a range or table.
 * Params:
 *   range      (string, optional)
 *   tableName  (string, optional)
 *   worksheet  (string, optional)
 *   sortFields (array, required) — [{ column, ascending }]
 */
async function sortRange(params: Record<string, unknown>): Promise<CommandResult> {
  const sortFields = params['sortFields'];
  if (!Array.isArray(sortFields) || sortFields.length === 0) {
    return { success: false, error: 'The "sortFields" parameter is required and must be a non-empty array.', code: 'INVALID_ARGUMENT' };
  }

  const rangeAddr = typeof params['range'] === 'string' ? params['range'] : undefined;
  const tableName = typeof params['tableName'] === 'string' ? params['tableName'] : undefined;
  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;

  if (!rangeAddr && !tableName) {
    return { success: false, error: 'Either "range" or "tableName" is required.', code: 'INVALID_ARGUMENT' };
  }

  return executeExcelCommand(async (context) => {
    if (tableName) {
      const table = context.workbook.tables.getItem(tableName);
      const headerRange = table.getHeaderRowRange();
      headerRange.load('values');
      await context.sync();

      const headers = (headerRange.values[0] ?? []) as string[];
      const fields = (sortFields as Array<{ column: string; ascending?: boolean }>).map((sf) => {
        const colIndex = headers.findIndex((h) => h === sf.column);
        return {
          key: colIndex >= 0 ? colIndex : 0,
          ascending: sf.ascending !== false,
        } as Excel.SortField;
      });

      table.sort.apply(fields);
    } else {
      const sheet = getWorksheet(context, worksheetName);
      const range = sheet.getRange(rangeAddr!);
      const fields = (sortFields as Array<{ column: string; ascending?: boolean }>).map((sf) => {
        // Column letter to 0-based index: 'A' → 0, 'B' → 1, etc.
        const colLetter = sf.column.toUpperCase();
        const colIndex = colLetter.charCodeAt(0) - 65;
        return {
          key: colIndex >= 0 ? colIndex : 0,
          ascending: sf.ascending !== false,
        } as Excel.SortField;
      });

      range.sort.apply(fields);
    }

    await context.sync();
    return { success: true };
  });
}

/**
 * filter_table — Apply or clear auto-filter on a table or range.
 * Params:
 *   tableName (string, optional)
 *   range     (string, optional)
 *   worksheet (string, optional)
 *   filters   (array, optional) — omit to clear all filters
 */
async function filterTable(params: Record<string, unknown>): Promise<CommandResult> {
  const tableName = typeof params['tableName'] === 'string' ? params['tableName'] : undefined;
  const rangeAddr = typeof params['range'] === 'string' ? params['range'] : undefined;
  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;
  const filters = Array.isArray(params['filters']) ? params['filters'] : undefined;

  if (!tableName && !rangeAddr) {
    return { success: false, error: 'Either "tableName" or "range" is required.', code: 'INVALID_ARGUMENT' };
  }

  return executeExcelCommand(async (context) => {
    if (tableName) {
      const table = context.workbook.tables.getItem(tableName);

      if (!filters) {
        // Clear all filters
        table.clearFilters();
        await context.sync();
        return { success: true, action: 'cleared' };
      }

      const headerRange = table.getHeaderRowRange();
      headerRange.load('values');
      await context.sync();

      const headers = (headerRange.values[0] ?? []) as string[];

      for (const f of filters as Array<{ column: string; criteria: { type: string; values?: string[]; operator?: string; value?: unknown } }>) {
        const colIndex = headers.findIndex((h) => h === f.column);
        if (colIndex < 0) continue;

        const column = table.columns.getItemAt(colIndex);
        if (f.criteria.type === 'values' && Array.isArray(f.criteria.values)) {
          column.filter.applyValuesFilter(f.criteria.values);
        } else if (f.criteria.type === 'condition') {
          const dynamicCriteria: Excel.FilterCriteria = {
            filterOn: Excel.FilterOn.custom,
            criterion1: `${f.criteria.operator ?? ''}${f.criteria.value ?? ''}`,
          };
          column.filter.applyCustomFilter(dynamicCriteria.criterion1!);
        }
      }
    } else {
      const sheet = getWorksheet(context, worksheetName);
      const range = sheet.getRange(rangeAddr!);

      if (!filters) {
        sheet.autoFilter.clearCriteria();
        await context.sync();
        return { success: true, action: 'cleared' };
      }

      // Apply auto-filter on the range
      sheet.autoFilter.apply(range);
    }

    await context.sync();
    return { success: true, action: 'applied' };
  });
}

/**
 * get_named_ranges — List all named ranges and tables.
 */
async function getNamedRanges(_params: Record<string, unknown>): Promise<CommandResult> {
  return executeExcelCommand(async (context) => {
    const names = context.workbook.names;
    names.load(['name', 'type', 'value', 'visible']);
    const tables = context.workbook.tables;
    tables.load(['name', 'id']);
    await context.sync();

    const namedRanges = names.items.map((n) => ({
      name: n.name,
      type: 'namedRange',
      value: n.value,
      visible: n.visible,
    }));

    const tableEntries = tables.items.map((t) => ({
      name: t.name,
      type: 'table',
      id: t.id,
    }));

    return {
      namedRanges,
      tables: tableEntries,
      totalCount: namedRanges.length + tableEntries.length,
    };
  });
}

/**
 * insert_rows_columns — Insert new rows or columns.
 * Params:
 *   type      ("rows" | "columns")
 *   position  (string) — row number or column letter to insert before
 *   count     (number, default 1)
 *   worksheet (string, optional)
 */
async function insertRowsColumns(params: Record<string, unknown>): Promise<CommandResult> {
  const insertType = params['type'];
  if (insertType !== 'rows' && insertType !== 'columns') {
    return { success: false, error: 'The "type" parameter must be "rows" or "columns".', code: 'INVALID_ARGUMENT' };
  }

  const position = params['position'];
  if (typeof position !== 'string' && typeof position !== 'number') {
    return { success: false, error: 'The "position" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const count = typeof params['count'] === 'number' && params['count'] > 0 ? params['count'] : 1;
  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const posStr = String(position);

    if (insertType === 'rows') {
      // Position is a row number: "5" means insert before row 5
      const rangeRef = `${posStr}:${Number(posStr) + count - 1}`;
      const range = sheet.getRange(rangeRef);
      range.insert(Excel.InsertShiftDirection.down);
    } else {
      // Position is a column letter: "C" means insert before column C
      const endColCode = posStr.charCodeAt(0) + count - 1;
      const endCol = String.fromCharCode(endColCode);
      const rangeRef = `${posStr}:${endCol}`;
      const range = sheet.getRange(rangeRef);
      range.insert(Excel.InsertShiftDirection.right);
    }

    await context.sync();
    return { success: true, type: insertType, position: posStr, count };
  });
}

/**
 * delete_rows_columns — Delete rows or columns.
 * Params:
 *   type      ("rows" | "columns")
 *   start     (string) — starting row number or column letter
 *   count     (number, default 1)
 *   worksheet (string, optional)
 */
async function deleteRowsColumns(params: Record<string, unknown>): Promise<CommandResult> {
  const deleteType = params['type'];
  if (deleteType !== 'rows' && deleteType !== 'columns') {
    return { success: false, error: 'The "type" parameter must be "rows" or "columns".', code: 'INVALID_ARGUMENT' };
  }

  const start = params['start'];
  if (typeof start !== 'string' && typeof start !== 'number') {
    return { success: false, error: 'The "start" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const count = typeof params['count'] === 'number' && params['count'] > 0 ? params['count'] : 1;
  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const startStr = String(start);

    if (deleteType === 'rows') {
      const endRow = Number(startStr) + count - 1;
      const rangeRef = `${startStr}:${endRow}`;
      const range = sheet.getRange(rangeRef);
      range.delete(Excel.DeleteShiftDirection.up);
    } else {
      const endColCode = startStr.charCodeAt(0) + count - 1;
      const endCol = String.fromCharCode(endColCode);
      const rangeRef = `${startStr}:${endCol}`;
      const range = sheet.getRange(rangeRef);
      range.delete(Excel.DeleteShiftDirection.left);
    }

    await context.sync();
    return { success: true, type: deleteType, start: startStr, count };
  });
}

/**
 * merge_cells — Merge or unmerge cells.
 * Params:
 *   range     (string, required)
 *   action    ("merge" | "unmerge")
 *   worksheet (string, optional)
 */
async function mergeCells(params: Record<string, unknown>): Promise<CommandResult> {
  const rangeAddr = params['range'];
  if (typeof rangeAddr !== 'string' || rangeAddr.length === 0) {
    return { success: false, error: 'The "range" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const action = params['action'];
  if (action !== 'merge' && action !== 'unmerge') {
    return { success: false, error: 'The "action" parameter must be "merge" or "unmerge".', code: 'INVALID_ARGUMENT' };
  }

  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const range = sheet.getRange(rangeAddr as string);

    if (action === 'merge') {
      range.merge();
    } else {
      range.unmerge();
    }

    await context.sync();
    return { success: true, action };
  });
}

/**
 * auto_fit — Auto-fit column widths or row heights.
 * Params:
 *   target    ("columns" | "rows" | "both", default "columns")
 *   range     (string, optional) — defaults to used range
 *   worksheet (string, optional)
 */
async function autoFit(params: Record<string, unknown>): Promise<CommandResult> {
  const target = typeof params['target'] === 'string' ? params['target'] : 'columns';
  const rangeAddr = typeof params['range'] === 'string' ? params['range'] : undefined;
  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const range = rangeAddr ? sheet.getRange(rangeAddr) : sheet.getUsedRange();

    if (target === 'columns' || target === 'both') {
      range.format.autofitColumns();
    }
    if (target === 'rows' || target === 'both') {
      range.format.autofitRows();
    }

    await context.sync();
    return { success: true, target };
  });
}

/**
 * add_data_validation — Add data validation rules to cells.
 * Params:
 *   range          (string, required)
 *   worksheet      (string, optional)
 *   rule           (object, required) — type, values, operator, minimum, maximum, formula
 *   showErrorAlert (boolean, default true)
 *   errorMessage   (string, optional)
 */
async function addDataValidation(params: Record<string, unknown>): Promise<CommandResult> {
  const rangeAddr = params['range'];
  if (typeof rangeAddr !== 'string' || rangeAddr.length === 0) {
    return { success: false, error: 'The "range" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const rule = params['rule'] as Record<string, unknown> | undefined;
  if (!rule || typeof rule !== 'object' || typeof rule['type'] !== 'string') {
    return { success: false, error: 'The "rule" parameter with a "type" field is required.', code: 'INVALID_ARGUMENT' };
  }

  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;
  const showErrorAlert = typeof params['showErrorAlert'] === 'boolean' ? params['showErrorAlert'] : true;
  const errorMessage = typeof params['errorMessage'] === 'string' ? params['errorMessage'] : undefined;

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const range = sheet.getRange(rangeAddr as string);

    const validation = range.dataValidation;

    switch (rule['type']) {
      case 'list': {
        const values = Array.isArray(rule['values']) ? rule['values'] : [];
        validation.rule = {
          list: { inCellDropDown: true, source: values.join(',') },
        };
        break;
      }

      case 'wholeNumber': {
        const operator = (rule['operator'] as string) ?? 'between';
        validation.rule = {
          wholeNumber: {
            formula1: String(rule['minimum'] ?? 0),
            formula2: operator === 'between' || operator === 'notBetween' ? String(rule['maximum'] ?? 100) : undefined,
            operator: operator as Excel.DataValidationOperator,
          },
        };
        break;
      }

      case 'decimal': {
        const operator = (rule['operator'] as string) ?? 'between';
        validation.rule = {
          decimal: {
            formula1: String(rule['minimum'] ?? 0),
            formula2: operator === 'between' || operator === 'notBetween' ? String(rule['maximum'] ?? 100) : undefined,
            operator: operator as Excel.DataValidationOperator,
          },
        };
        break;
      }

      case 'date': {
        const operator = (rule['operator'] as string) ?? 'between';
        validation.rule = {
          date: {
            formula1: String(rule['minimum'] ?? ''),
            formula2: operator === 'between' || operator === 'notBetween' ? String(rule['maximum'] ?? '') : undefined,
            operator: operator as Excel.DataValidationOperator,
          },
        };
        break;
      }

      case 'textLength': {
        const operator = (rule['operator'] as string) ?? 'between';
        validation.rule = {
          textLength: {
            formula1: String(rule['minimum'] ?? 0),
            formula2: operator === 'between' || operator === 'notBetween' ? String(rule['maximum'] ?? 100) : undefined,
            operator: operator as Excel.DataValidationOperator,
          },
        };
        break;
      }

      case 'custom': {
        const formula = typeof rule['formula'] === 'string' ? rule['formula'] : '=TRUE';
        validation.rule = {
          custom: { formula },
        };
        break;
      }

      default:
        throw new Error(`Unsupported validation type: "${rule['type'] as string}".`);
    }

    if (showErrorAlert || errorMessage) {
      validation.errorAlert = {
        showAlert: showErrorAlert,
        message: errorMessage ?? 'Invalid value entered.',
        title: 'Validation Error',
        style: Excel.DataValidationAlertStyle.stop,
      };
    }

    await context.sync();
    return { success: true };
  });
}

/**
 * get_comments — Read all comments in the workbook or a specific sheet.
 * Requires ExcelApi 1.10+.
 * Params:
 *   worksheet       (string, optional) — limit to a specific sheet
 *   includeResolved (boolean, default false)
 */
async function getComments(params: Record<string, unknown>): Promise<CommandResult> {
  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;
  const includeResolved =
    typeof params['includeResolved'] === 'boolean' ? params['includeResolved'] : false;

  return executeExcelCommand(async (context) => {
    const sheets: Excel.Worksheet[] = [];
    if (worksheetName) {
      sheets.push(context.workbook.worksheets.getItem(worksheetName));
    } else {
      const allSheets = context.workbook.worksheets;
      allSheets.load('items');
      await context.sync();
      sheets.push(...allSheets.items);
    }

    const allComments: Array<{
      id: string;
      cell: string;
      author: string;
      text: string;
      date: string;
      resolved: boolean;
      worksheet: string;
      replies: Array<{ id: string; author: string; text: string; date: string }>;
    }> = [];

    for (const sheet of sheets) {
      sheet.load('name');
      const comments = sheet.comments;
      comments.load(['id', 'authorName', 'content', 'creationDate', 'resolved']);
      await context.sync();

      for (const comment of comments.items) {
        if (!includeResolved && comment.resolved) continue;

        // Load the cell reference via the comment's getLocation() method
        let cellRef = '';
        try {
          const location = comment.getLocation();
          location.load('address');
          await context.sync();
          cellRef = location.address ?? '';
        } catch {
          // getLocation() may not be available in older ExcelApi versions
        }

        // Load replies
        const replies = comment.replies;
        replies.load(['id', 'authorName', 'content', 'creationDate']);
        await context.sync();

        allComments.push({
          id: comment.id,
          cell: cellRef,
          author: comment.authorName,
          text: comment.content,
          date: comment.creationDate?.toISOString?.() ?? '',
          resolved: comment.resolved,
          worksheet: sheet.name,
          replies: replies.items.map((r) => ({
            id: r.id,
            author: r.authorName,
            text: r.content,
            date: r.creationDate?.toISOString?.() ?? '',
          })),
        });
      }
    }

    return { commentCount: allComments.length, comments: allComments };
  });
}

/**
 * add_comment — Add a comment to a cell.
 * Requires ExcelApi 1.10+.
 * Params:
 *   cell              (string, required) — A1 notation
 *   text              (string, required)
 *   worksheet         (string, optional)
 *   replyToCommentId  (string, optional) — parent comment for threaded reply
 */
async function addComment(params: Record<string, unknown>): Promise<CommandResult> {
  const text = params['text'];
  if (typeof text !== 'string' || text.length === 0) {
    return { success: false, error: 'The "text" parameter is required.', code: 'INVALID_ARGUMENT' };
  }

  const replyToCommentId = typeof params['replyToCommentId'] === 'string' ? params['replyToCommentId'] : undefined;
  const worksheetName = typeof params['worksheet'] === 'string' ? params['worksheet'] : undefined;

  // Reply to existing comment
  if (replyToCommentId) {
    return executeExcelCommand(async (context) => {
      const sheet = getWorksheet(context, worksheetName);
      const comment = sheet.comments.getItem(replyToCommentId);
      const reply = comment.replies.add(text as string);
      reply.load('id');
      await context.sync();

      return { success: true, replyId: reply.id, parentCommentId: replyToCommentId };
    });
  }

  // New comment on a cell
  const cell = params['cell'];
  if (typeof cell !== 'string' || cell.length === 0) {
    return { success: false, error: 'The "cell" parameter is required for new comments.', code: 'INVALID_ARGUMENT' };
  }

  return executeExcelCommand(async (context) => {
    const sheet = getWorksheet(context, worksheetName);
    const range = sheet.getRange(cell as string);
    const comment = sheet.comments.add(range, text as string);
    comment.load('id');
    await context.sync();

    return { success: true, commentId: comment.id };
  });
}

/**
 * get_pivot_tables — List all pivot tables in the workbook.
 * Params: (none)
 */
async function getPivotTables(_params: Record<string, unknown>): Promise<CommandResult> {
  return executeExcelCommand(async (context) => {
    const pivotTables = context.workbook.pivotTables;
    pivotTables.load('items');
    await context.sync();

    for (const pivotTable of pivotTables.items) {
      pivotTable.load(['name']);
      pivotTable.worksheet.load(['name']);
    }
    await context.sync();

    return {
      pivotTables: pivotTables.items.map((pivotTable) => ({
        name: pivotTable.name,
        worksheet: pivotTable.worksheet.name,
      })),
      count: pivotTables.items.length,
    };
  });
}

/**
 * create_pivot_table — Create a pivot table from a source range.
 * Params:
 *   name                 (string, required) — pivot table name
 *   sourceRange          (string, required) — A1 range of the source data (e.g. "A1:D100")
 *   sourceWorksheet      (string, optional) — worksheet holding the source range (default: active)
 *   destinationWorksheet (string, optional) — worksheet to place the pivot table on; when
 *                                             omitted, a new worksheet named after the pivot
 *                                             table is created (it must not already exist)
 *   destinationCell      (string, optional) — top-left cell of the pivot table (default "A1")
 */
async function createPivotTable(params: Record<string, unknown>): Promise<CommandResult> {
  const name = params['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    return {
      success: false,
      error: 'The "name" parameter is required and must be a non-empty string.',
      code: 'INVALID_ARGUMENT',
    };
  }

  const sourceRange = params['sourceRange'];
  if (typeof sourceRange !== 'string' || sourceRange.trim().length === 0) {
    return {
      success: false,
      error: 'The "sourceRange" parameter is required and must be an A1-style range (e.g. "A1:D100").',
      code: 'INVALID_ARGUMENT',
    };
  }

  const sourceWorksheet = typeof params['sourceWorksheet'] === 'string' ? params['sourceWorksheet'] : undefined;
  const destinationWorksheet =
    typeof params['destinationWorksheet'] === 'string' ? params['destinationWorksheet'] : undefined;
  const destinationCell =
    typeof params['destinationCell'] === 'string' && params['destinationCell'].trim().length > 0
      ? params['destinationCell']
      : 'A1';

  return executeExcelCommand(async (context) => {
    const sourceSheet = getWorksheet(context, sourceWorksheet);
    const source = sourceSheet.getRange(sourceRange as string);

    let destinationSheet: Excel.Worksheet;
    if (destinationWorksheet) {
      destinationSheet = context.workbook.worksheets.getItem(destinationWorksheet);
    } else {
      destinationSheet = context.workbook.worksheets.add(name as string);
    }

    const pivotTable = destinationSheet.pivotTables.add(
      name as string,
      source,
      destinationSheet.getRange(destinationCell),
    );
    pivotTable.load(['name']);
    destinationSheet.load(['name']);
    await context.sync();

    return {
      success: true,
      name: pivotTable.name,
      worksheet: destinationSheet.name,
      note: 'Pivot table created without fields. Arrange row/column/value fields in Excel to build the report.',
    };
  });
}

/**
 * refresh_pivot_table — Refresh one pivot table by name, or all when no name is given.
 * Params:
 *   name (string, optional) — pivot table name; omit to refresh every pivot table
 */
async function refreshPivotTable(params: Record<string, unknown>): Promise<CommandResult> {
  const name = typeof params['name'] === 'string' && params['name'].trim().length > 0 ? params['name'] : undefined;

  return executeExcelCommand(async (context) => {
    if (name) {
      const pivotTable = context.workbook.pivotTables.getItem(name);
      pivotTable.refresh();
      await context.sync();
      return { success: true, refreshed: name };
    }

    context.workbook.pivotTables.refreshAll();
    await context.sync();
    return { success: true, refreshed: 'all' };
  });
}
