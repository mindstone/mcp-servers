import type {
  AnchorReadResponse,
  CellTriad,
  CellValue,
  ColumnType,
  ContinuationTokenPayload,
  ShapedReadResponse,
  ShapedWarning,
} from './types.js';
import { parseA1Range } from './a1Utils.js';

export type {
  AnchorReadResponse,
  CellTriad,
  ColumnType,
  ContinuationTokenPayload,
  ShapedReadResponse,
  ShapedWarning,
} from './types.js';

export interface InferredHeaderResult {
  inferredHeaders?: string[];
  inferredHeaderConfidence: 'high' | 'medium' | 'low' | 'none';
  columnTypes: ColumnType[];
  warnings: ShapedWarning[];
}

export interface BuildAnchorEnvelopeInput {
  range: string;
  firstWindow: CellTriad[][];
  firstWindowStartRow: number;
  lastWindow?: CellTriad[][];
  lastWindowStartRow?: number;
  totalRowCount: number;
  rowCountAtIssue?: number;
  columnCount: number;
  spreadsheetId: string;
  sheetId?: number;
  sheetTitle?: string;
  nextEmptyRow?: number;
  warnings?: ShapedWarning[];
}

export interface ColumnPopulationInput {
  cells: CellTriad[][];
  startColumnIndex?: number;
  startColumnLetter?: string;
  headerRow?: CellTriad[];
  totalRowCount?: number;
}

export interface ParsedContinuationToken {
  payload: ContinuationTokenPayload;
}

export class ContinuationTokenError extends Error {
  readonly suggestion: string;

  constructor(message: string, suggestion: string) {
    super(message);
    this.name = 'ContinuationTokenError';
    this.suggestion = suggestion;
  }
}

const CURRENCY_REGEX = /^[$£€¥]\s*\d/;
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/;

function isFormulaCellValue(value: CellValue | undefined): value is string {
  return typeof value === 'string' && value.trim().startsWith('=');
}

function normaliseCellValue(value: CellValue | undefined): CellValue {
  return value === undefined ? null : value;
}

function isEmptyCell(cell: CellTriad): boolean {
  if (cell.formula) {
    return false;
  }

  if (cell.value === null || cell.value === undefined) {
    return true;
  }

  return typeof cell.value === 'string' && cell.value.trim() === '';
}

function cellToHeaderCandidate(cell: CellTriad): string {
  if (cell.value === null || cell.value === undefined) {
    return '';
  }
  return String(cell.value);
}

function buildPaddingCell(): CellTriad {
  return { value: null };
}

function getCellAt(cells: CellTriad[][], rowIndex: number, columnIndex: number): CellTriad {
  return cells[rowIndex]?.[columnIndex] ?? buildPaddingCell();
}

function isDateLike(value: CellValue): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (ISO_8601_REGEX.test(trimmed)) {
    return true;
  }

  return !Number.isNaN(new Date(trimmed).getTime());
}

function inferColumnType(columnCells: CellTriad[]): ColumnType {
  const nonEmpty = columnCells.filter((cell) => !isEmptyCell(cell));
  if (nonEmpty.length === 0) {
    return 'empty';
  }

  if (nonEmpty.every((cell) => typeof cell.formula === 'string' && cell.formula.trim().startsWith('='))) {
    return 'formula';
  }

  const numericCount = nonEmpty.filter((cell) => typeof cell.value === 'number').length;
  if (numericCount / nonEmpty.length >= 0.8) {
    return 'number';
  }

  const booleanCount = nonEmpty.filter((cell) => typeof cell.value === 'boolean').length;
  if (booleanCount / nonEmpty.length >= 0.8) {
    return 'boolean';
  }

  const nonEmptyStringValues = nonEmpty
    .map((cell) => cell.value)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  if (
    nonEmptyStringValues.length === nonEmpty.length &&
    nonEmptyStringValues.every((value) => CURRENCY_REGEX.test(value))
  ) {
    return 'currency';
  }

  const dateLikeCount = nonEmpty.filter((cell) => isDateLike(cell.value)).length;
  if (dateLikeCount / nonEmpty.length >= 0.8) {
    return 'date';
  }

  if (nonEmptyStringValues.length / nonEmpty.length >= 0.8) {
    return 'text';
  }

  return 'mixed';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function columnLetterToIndex(columnLetter: string): number {
  const normalized = columnLetter.trim().toUpperCase();
  let index = 0;
  for (const char of normalized) {
    const charCode = char.charCodeAt(0);
    if (charCode < 65 || charCode > 90) {
      return 0;
    }
    index = index * 26 + (charCode - 64);
  }
  return index;
}

function columnIndexToLetter(columnIndex: number): string {
  if (!Number.isFinite(columnIndex) || columnIndex <= 0) {
    return 'A';
  }

  let index = Math.trunc(columnIndex);
  let output = '';
  while (index > 0) {
    const remainder = (index - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    index = Math.floor((index - 1) / 26);
  }

  return output;
}

function normaliseColumnBounds(
  range: string,
  columnCount: number,
): { startCol: string; endCol: string } {
  const parsed = parseA1Range(range);
  const parsedStartCol = parsed?.startCol?.toUpperCase();
  const parsedEndCol = parsed?.endCol?.toUpperCase();
  const startCol = parsedStartCol && columnLetterToIndex(parsedStartCol) > 0 ? parsedStartCol : 'A';
  if (parsedEndCol && columnLetterToIndex(parsedEndCol) > 0) {
    return { startCol, endCol: parsedEndCol };
  }

  const startIndex = columnLetterToIndex(startCol) || 1;
  const safeColumnCount = Math.max(1, Math.trunc(columnCount));
  const endIndex = startIndex + safeColumnCount - 1;
  return { startCol, endCol: columnIndexToLetter(endIndex) };
}

function decodeBase64Json(token: string): ContinuationTokenPayload {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new ContinuationTokenError(
      'Invalid continuation token: token is empty.',
      `Issue a fresh read with anchor_mode='always' to obtain a new continuation token.`,
    );
  }

  const base64Candidates = [trimmed];
  if (!trimmed.includes('+') && !trimmed.includes('/')) {
    const rem = trimmed.length % 4;
    const padding = rem === 0 ? '' : '='.repeat(4 - rem);
    base64Candidates.push(trimmed.replace(/-/g, '+').replace(/_/g, '/') + padding);
  }

  let decoded: string | undefined;
  for (const candidate of base64Candidates) {
    try {
      decoded = Buffer.from(candidate, 'base64').toString('utf8');
      if (decoded.length > 0) {
        break;
      }
    } catch {
      // Continue trying candidates.
    }
  }

  if (!decoded) {
    throw new ContinuationTokenError(
      'Invalid continuation token: token is not valid base64 JSON.',
      `Issue a fresh read with anchor_mode='always' to obtain a new continuation token.`,
    );
  }

  try {
    return JSON.parse(decoded) as ContinuationTokenPayload;
  } catch {
    throw new ContinuationTokenError(
      'Invalid continuation token: token JSON payload could not be parsed.',
      `Issue a fresh read with anchor_mode='always' to obtain a new continuation token.`,
    );
  }
}

function validateContinuationPayloadBase(
  payload: ContinuationTokenPayload,
  expected: { spreadsheetId: string; currentRowCount?: number },
): void {
  if (payload.v !== 1) {
    throw new ContinuationTokenError(
      `Unsupported continuation token version '${String(payload.v)}'.`,
      `Issue a fresh read with anchor_mode='always' to obtain a v1 token.`,
    );
  }

  if (payload.spreadsheetId !== expected.spreadsheetId) {
    throw new ContinuationTokenError(
      'Continuation token does not match the requested spreadsheet.',
      'Use a continuation_token generated from this spreadsheet, or run a fresh read to get a new token.',
    );
  }

  // TODO(phase2): Allow single-row continuation windows (startRow === endRow).
  // This edge case can occur when total rows = firstRows + lastRows + 1 (for example 61 = 50 + 10 + 1).
  if (!isPositiveInteger(payload.startRow) || !isPositiveInteger(payload.endRow) || payload.endRow <= payload.startRow) {
    throw new ContinuationTokenError(
      'Continuation token row bounds are invalid.',
      `Issue a fresh read with anchor_mode='always' and use the returned continuation token.`,
    );
  }

  if (payload.endRow - payload.startRow > 10_000) {
    throw new ContinuationTokenError(
      'Continuation token page is too large (maximum 10,000 rows).',
      'Issue a fresh read to obtain a smaller continuation window.',
    );
  }

  if (!isPositiveInteger(payload.rowCountAtIssue)) {
    throw new ContinuationTokenError(
      'Continuation token is missing a valid rowCountAtIssue value.',
      `Issue a fresh read with anchor_mode='always' to obtain a valid token.`,
    );
  }

  if (expected.currentRowCount !== undefined && isPositiveInteger(expected.currentRowCount)) {
    const driftRatio = Math.abs(expected.currentRowCount - payload.rowCountAtIssue) / payload.rowCountAtIssue;
    if (driftRatio > 0.1) {
      throw new ContinuationTokenError(
        `Sheet has changed materially since token was issued (was ${payload.rowCountAtIssue} rows, now ${expected.currentRowCount} rows).`,
        `Issue a fresh read with anchor_mode='always' instead of using a stale token.`,
      );
    }
  }
}

function mergeWindowsForSummary(input: BuildAnchorEnvelopeInput): CellTriad[][] {
  const firstWindowEnd = input.firstWindowStartRow + input.firstWindow.length - 1;
  const mergedRows = [...input.firstWindow];

  if (!input.lastWindow || input.lastWindow.length === 0 || input.lastWindowStartRow === undefined) {
    return mergedRows;
  }

  for (let index = 0; index < input.lastWindow.length; index += 1) {
    const absoluteRow = input.lastWindowStartRow + index;
    if (absoluteRow <= firstWindowEnd) {
      continue;
    }
    mergedRows.push(input.lastWindow[index]);
  }

  return mergedRows;
}

export function mergeFormulaAndValue(
  formattedValues: ReadonlyArray<ReadonlyArray<string | number | boolean | null>> | undefined,
  formulaValues: ReadonlyArray<ReadonlyArray<string | number | boolean | null>> | undefined,
): CellTriad[][] {
  const merged: CellTriad[][] = [];
  const rowCount = Math.max(formattedValues?.length ?? 0, formulaValues?.length ?? 0);

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const formattedRow = formattedValues?.[rowIndex] ?? [];
    const formulaRow = formulaValues?.[rowIndex] ?? [];
    const columnCount = Math.max(formattedRow.length, formulaRow.length);
    const mergedRow: CellTriad[] = [];

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const formattedCell = normaliseCellValue(formattedRow[columnIndex]);
      const formulaCandidate = formulaRow[columnIndex];
      const formula = isFormulaCellValue(formulaCandidate) ? formulaCandidate : undefined;

      const fallbackValue = formula === undefined ? normaliseCellValue(formulaCandidate) : null;
      const value = formattedRow[columnIndex] !== undefined ? formattedCell : fallbackValue;

      const triad: CellTriad = { value };
      if (formula) {
        triad.formula = formula;
      }

      mergedRow.push(triad);
    }

    merged.push(mergedRow);
  }

  return merged;
}

export function columnPopulationSummary(
  input: ColumnPopulationInput,
): AnchorReadResponse['columnSummary'] {
  const cells = input.cells ?? [];
  const headerLength = input.headerRow?.length ?? 0;
  const columnCount = Math.max(headerLength, ...cells.map((row) => row.length), 0);
  const totalRowCount = Math.max(0, Math.trunc(input.totalRowCount ?? cells.length));
  const startColumnIndex = input.startColumnLetter
    ? Math.max(0, columnLetterToIndex(input.startColumnLetter) - 1)
    : Math.max(0, input.startColumnIndex ?? 0);

  const summary: AnchorReadResponse['columnSummary'] = [];
  for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
    const columnCells = cells.map((row) => row[columnOffset] ?? buildPaddingCell());
    const nonEmptyCount = columnCells.filter((cell) => !isEmptyCell(cell)).length;
    const headerSampleValue = input.headerRow?.[columnOffset]?.value;
    const headerSample =
      typeof headerSampleValue === 'string' && headerSampleValue.trim().length > 0
        ? headerSampleValue
        : undefined;

    summary.push({
      column: columnIndexToLetter(startColumnIndex + columnOffset + 1),
      nonEmptyCount,
      populationRatio: totalRowCount > 0 ? nonEmptyCount / totalRowCount : 0,
      inferredType: inferColumnType(columnCells),
      headerSample,
    });
  }

  return summary;
}

export function buildContinuationToken(payload: ContinuationTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function parseContinuationToken(
  token: string,
  expected: { spreadsheetId: string; currentRowCount?: number },
): ContinuationTokenPayload {
  const payload = decodeBase64Json(token);
  validateContinuationPayloadBase(payload, expected);
  return payload;
}

export function buildAnchorEnvelope(input: BuildAnchorEnvelopeInput): AnchorReadResponse {
  const { startCol, endCol } = normaliseColumnBounds(input.range, input.columnCount);
  const combinedRows = mergeWindowsForSummary(input);
  const firstWindowEnd = input.firstWindowStartRow + input.firstWindow.length - 1;
  const hasLastWindow =
    !!input.lastWindow &&
    input.lastWindow.length > 0 &&
    input.lastWindowStartRow !== undefined &&
    input.lastWindowStartRow > firstWindowEnd;
  const omittedStart = firstWindowEnd + 1;
  const omittedEnd = hasLastWindow ? (input.lastWindowStartRow as number) - 1 : 0;
  const truncated = hasLastWindow && omittedEnd >= omittedStart;

  const response: AnchorReadResponse = {
    range: input.range,
    rowCount: input.totalRowCount,
    columnCount: input.columnCount,
    firstRows: input.firstWindow,
    firstRowsStartRow: input.firstWindowStartRow,
    columnSummary: columnPopulationSummary({
      cells: combinedRows,
      startColumnLetter: startCol,
      headerRow: input.firstWindow[0],
      totalRowCount: input.totalRowCount,
    }),
    truncated,
    warnings: input.warnings && input.warnings.length > 0 ? input.warnings : undefined,
  };

  if (input.nextEmptyRow !== undefined) {
    response.nextEmptyRow = input.nextEmptyRow;
  }

  if (hasLastWindow && input.lastWindow && input.lastWindowStartRow !== undefined) {
    response.lastRows = input.lastWindow;
    response.lastRowsStartRow = input.lastWindowStartRow;
  }

  if (truncated && omittedEnd >= omittedStart) {
    const continuationPayload: ContinuationTokenPayload = {
      v: 1,
      spreadsheetId: input.spreadsheetId,
      sheetId: input.sheetId,
      sheet: input.sheetTitle,
      startRow: omittedStart,
      endRow: omittedEnd,
      startCol,
      endCol,
      issuedAt: Date.now(),
      rowCountAtIssue: input.rowCountAtIssue ?? input.totalRowCount,
    };

    response.continuationToken = buildContinuationToken(continuationPayload);
    response.omittedRowsSummary =
      `Rows ${omittedStart}-${omittedEnd} omitted. Do not infer totals or append position from displayed rows. Pass continuation_token to read further.`;
  }

  return response;
}

export function inferHeadersAndTypes(cells: CellTriad[][]): InferredHeaderResult {
  const warnings: ShapedWarning[] = [];
  const rowLengths = cells.map((row) => row.length);
  const columnCount = rowLengths.length > 0 ? Math.max(...rowLengths) : 0;

  if (new Set(rowLengths).size > 1) {
    warnings.push({
      kind: 'non_rectangular',
      message: 'Rows have different lengths; data may contain merged or sparse cells.',
      detail: { rowLengths },
    });
  }

  if (cells.length === 0 || columnCount === 0) {
    return {
      inferredHeaderConfidence: 'none',
      columnTypes: [],
      warnings,
    };
  }

  const firstRow = Array.from({ length: columnCount }, (_, columnIndex) =>
    getCellAt(cells, 0, columnIndex),
  );

  const row1AllNonEmptyStrings = firstRow.every(
    (cell) => typeof cell.value === 'string' && cell.value.trim().length > 0,
  );
  const row1HasFormula = firstRow.some((cell) => typeof cell.formula === 'string' && cell.formula.length > 0);
  const row1HasNumber = firstRow.some((cell) => typeof cell.value === 'number');
  const row1HasString = firstRow.some((cell) => typeof cell.value === 'string' && cell.value.trim().length > 0);
  const row1MixedNumbersAndStrings = row1HasNumber && row1HasString;

  let inferredHeaders: string[] | undefined;
  let inferredHeaderConfidence: InferredHeaderResult['inferredHeaderConfidence'] = 'none';

  if (cells.length > 1 && row1AllNonEmptyStrings && !row1HasFormula) {
    const dataCells = cells
      .slice(1)
      .flatMap((row, rowOffset) =>
        Array.from({ length: columnCount }, (_, columnIndex) => getCellAt(cells, rowOffset + 1, columnIndex)),
      )
      .filter((cell) => !isEmptyCell(cell));

    const nonStringLikeCount = dataCells.filter((cell) => {
      if (cell.formula) {
        return true;
      }

      if (typeof cell.value === 'number' || typeof cell.value === 'boolean') {
        return true;
      }

      return isDateLike(cell.value);
    }).length;

    inferredHeaders = firstRow.map(cellToHeaderCandidate);
    if (dataCells.length > 0 && nonStringLikeCount / dataCells.length >= 0.6) {
      inferredHeaderConfidence = 'high';
    } else {
      inferredHeaderConfidence = 'medium';
    }
  } else if (cells.length > 1 && row1HasFormula) {
    inferredHeaders = firstRow.map(cellToHeaderCandidate);
    inferredHeaderConfidence = row1AllNonEmptyStrings ? 'medium' : 'none';
    warnings.push({
      kind: 'headers_ambiguous',
      message: 'Row 1 contains formula(s) — header inference uncertain',
    });
  } else if (cells.length > 1 && row1MixedNumbersAndStrings) {
    inferredHeaders = firstRow.map(cellToHeaderCandidate);
    inferredHeaderConfidence = 'low';
    warnings.push({
      kind: 'headers_ambiguous',
      message: 'Row 1 mixes numbers and strings — header inference uncertain',
    });
  }

  const startRowIndex = inferredHeaders ? 1 : 0;
  const columnTypes: ColumnType[] = [];
  const mixedColumns: number[] = [];

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const columnCells: CellTriad[] = [];
    for (let rowIndex = startRowIndex; rowIndex < cells.length; rowIndex += 1) {
      columnCells.push(getCellAt(cells, rowIndex, columnIndex));
    }

    const columnType = inferColumnType(columnCells);
    columnTypes.push(columnType);
    if (columnType === 'mixed') {
      mixedColumns.push(columnIndex + 1);
    }
  }

  if (mixedColumns.length > 0) {
    warnings.push({
      kind: 'mixed_column_types',
      message: 'One or more columns contain mixed value types.',
      detail: { columns: mixedColumns },
    });
  }

  return {
    inferredHeaders,
    inferredHeaderConfidence,
    columnTypes,
    warnings,
  };
}

export function buildShapedReadResponse(
  range: string,
  formattedValues: ReadonlyArray<ReadonlyArray<string | number | boolean | null>> | undefined,
  formulaValues: ReadonlyArray<ReadonlyArray<string | number | boolean | null>> | undefined,
): ShapedReadResponse {
  const cells = mergeFormulaAndValue(formattedValues, formulaValues);
  const rowCount = cells.length;
  const columnCount = rowCount > 0 ? Math.max(...cells.map((row) => row.length)) : 0;
  const formulaCellCount = cells.flat().filter((cell) => typeof cell.formula === 'string').length;
  const inferred = inferHeadersAndTypes(cells);

  return {
    range,
    rowCount,
    columnCount,
    inferredHeaders: inferred.inferredHeaders,
    inferredHeaderConfidence: inferred.inferredHeaderConfidence,
    columnTypes: inferred.columnTypes,
    formulaCellCount,
    cells,
    warnings: inferred.warnings.length > 0 ? inferred.warnings : undefined,
  };
}
