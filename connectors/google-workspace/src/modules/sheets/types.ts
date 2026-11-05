import { sheets_v4 } from 'googleapis';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { FormulaCellRef, SuspiciousWriteWarning } from './writeGuards.js';
export type { FormulaCellRef, SuspiciousWriteWarning } from './writeGuards.js';

// Re-export Google API types for convenience
export type Spreadsheet = sheets_v4.Schema$Spreadsheet;
export type Sheet = sheets_v4.Schema$Sheet;
export type SheetProperties = sheets_v4.Schema$SheetProperties;
export type CellData = sheets_v4.Schema$CellData;
export type RowData = sheets_v4.Schema$RowData;
export type GridData = sheets_v4.Schema$GridData;
export type ValueRange = sheets_v4.Schema$ValueRange;
export type BatchUpdateRequest = sheets_v4.Schema$BatchUpdateSpreadsheetRequest;
export type BatchUpdateResponse = sheets_v4.Schema$BatchUpdateSpreadsheetResponse;
export type Request = sheets_v4.Schema$Request;

export type CellValue = string | number | boolean | null;
export type ReadValueView = 'formatted' | 'shaped' | 'formula' | 'unformatted';
export type AnchorMode = 'auto' | 'always' | 'never';

export type ColumnType =
  | 'number'
  | 'currency'
  | 'date'
  | 'text'
  | 'formula'
  | 'boolean'
  | 'empty'
  | 'mixed';

export interface CellTriad {
  value: CellValue;
  unformattedValue?: CellValue;
  formula?: string;
}

export interface ShapedWarning {
  kind: 'non_rectangular' | 'merged_cells_detected' | 'mixed_column_types' | 'headers_ambiguous';
  message: string;
  detail?: Record<string, unknown>;
}

export interface ShapedReadResponse {
  range: string;
  rowCount: number;
  columnCount: number;
  inferredHeaders?: string[];
  inferredHeaderConfidence?: 'high' | 'medium' | 'low' | 'none';
  columnTypes?: ColumnType[];
  formulaCellCount: number;
  cells: CellTriad[][];
  warnings?: ShapedWarning[];
  truncated?: boolean;
}

export interface ContinuationTokenPayload {
  v: 1;
  spreadsheetId: string;
  sheetId?: number;
  sheet?: string;
  startRow: number;
  endRow: number;
  startCol?: string;
  endCol?: string;
  issuedAt: number;
  rowCountAtIssue: number;
}

export interface AnchorReadResponse {
  range: string;
  rowCount: number;
  columnCount: number;
  firstRows: CellTriad[][];
  firstRowsStartRow: number;
  lastRows?: CellTriad[][];
  lastRowsStartRow?: number;
  nextEmptyRow?: number;
  columnSummary: Array<{
    column: string;
    nonEmptyCount: number;
    populationRatio: number;
    inferredType: ColumnType;
    headerSample?: string;
  }>;
  continuationToken?: string;
  truncated: boolean;
  omittedRowsSummary?: string;
  warnings?: ShapedWarning[];
}

export interface ReadSpreadsheetOptions {
  range?: string; // A1 notation (e.g., "Sheet1!A1:D10")
  maxRows?: number;
  maxCols?: number;
  returnJson?: boolean; // Default: false (human-readable text)
  valueView?: ReadValueView;
  anchorMode?: AnchorMode;
  continuationToken?: string;
}

export interface ReadValuesOptions {
  range: string; // A1 notation, required
  maxRows?: number;
  maxCols?: number;
  majorDimension?: 'ROWS' | 'COLUMNS';
  returnJson?: boolean;
  valueView?: ReadValueView;
  anchorMode?: AnchorMode;
  continuationToken?: string;
  internalCall?: boolean; // Service-internal forwarding (e.g. getSpreadsheet -> getValues)
}

export interface CreateSpreadsheetOptions {
  title: string;
  sheetTitles?: string[]; // Optional initial sheet names
}

export interface AppendValuesOptions {
  spreadsheetId: string;
  range: string; // A1 notation for where to start appending
  values: CellValue[][]; // 2D array of values
  valueInputOption?: 'RAW' | 'USER_ENTERED'; // Default: USER_ENTERED
  overwriteFormulas?: boolean;
}

export interface UpdateValuesOptions {
  spreadsheetId: string;
  range: string; // A1 notation
  values: CellValue[][];
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  overwriteFormulas?: boolean;
}

export interface ClearValuesOptions {
  spreadsheetId: string;
  range: string; // A1 notation
}

export interface AddSheetOptions {
  spreadsheetId: string;
  title: string;
  rowCount?: number;
  columnCount?: number;
}

export interface DeleteSheetOptions {
  spreadsheetId: string;
  sheetId: number; // Numeric sheet ID (not title)
}

export interface SheetInfo {
  sheetId: number;
  title: string;
  index: number;
  rowCount?: number;
  columnCount?: number;
}

/**
 * Input error raised by the sheet-management methods (unknown sheet, position
 * out of range, …). Service catches rethrow it so the caller sees InvalidParams
 * instead of a generic API failure.
 */
export class SheetsInputError extends McpError {
  constructor(message: string) {
    super(ErrorCode.InvalidParams, message);
    this.name = 'SheetsInputError';
  }
}

export interface DuplicateSheetOptions {
  spreadsheetId: string;
  /** Exactly one of sheetId / sheetTitle (the sheet to copy). */
  sheetId?: number;
  sheetTitle?: string;
  /** Name for the copy; Google names it "Copy of …" when omitted. */
  title?: string;
  /** 0-based position for the copy; defaults to right after the source. */
  position?: number;
}

export interface UpdateSheetOptions {
  spreadsheetId: string;
  /** Exactly one of sheetId / sheetTitle (the sheet's current title). */
  sheetId?: number;
  sheetTitle?: string;
  title?: string;
  /** 0-based final position among all sheets. */
  position?: number;
}

export type SheetDimension = 'ROWS' | 'COLUMNS';

export interface InsertDimensionOptions {
  spreadsheetId: string;
  /** Exactly one of sheetId / sheetTitle. */
  sheetId?: number;
  sheetTitle?: string;
  dimension: SheetDimension;
  /** 0-based index the first new row/column gets. */
  startIndex: number;
  count?: number;
  /** Copy formatting from the row/column before the insert (default) or after it. */
  inheritFrom?: 'before' | 'after';
}

export interface SheetDuplicateResponse {
  spreadsheetId: string;
  sourceSheetId: number;
  sheet: SheetInfo;
  requestedPosition: number;
}

export interface SheetUpdateResponse {
  spreadsheetId: string;
  sheet: SheetInfo;
  /** False when the sheet already had that title and position (no write was made). */
  changed: boolean;
  requestedPosition: number;
}

export interface DimensionInsertResponse {
  spreadsheetId: string;
  sheet: SheetInfo;
  dimension: SheetDimension;
  startIndex: number;
  count: number;
  inheritFromBefore: boolean;
  /** The inserted rows/columns in A1 notation, e.g. `'Q2 Data'!F:F` or `Sheet1!6:7`. */
  a1Range: string;
}

export interface SheetTabOperationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SpreadsheetResponse {
  title: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  sheets?: SheetInfo[];
  values?: CellValue[][];
  /** A1 range `values` came from, used to number rows in text output (not set in JSON results). */
  valuesRange?: string;
  truncated?: boolean;
  shapedValues?: ShapedReadResponse;
  anchorValues?: AnchorReadResponse;
}

export interface WriteResponse {
  title: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  warnings?: SuspiciousWriteWarning[];
}

export type FormulaSafetyErrorCode = 'formula_overwrite_refused' | 'formula_safety_unverifiable';

export interface FormulaOverwriteRefusal {
  status: 'refused';
  error_code: FormulaSafetyErrorCode;
  error: string;
  retry_with: {
    overwrite_formulas: true;
  };
  alternatives: string[];
  formula_cells?: FormulaCellRef[];
}

export interface SheetsOperationResult {
  success: boolean;
  data?: SpreadsheetResponse | Spreadsheet | SheetInfo | ValueRange | ShapedReadResponse | AnchorReadResponse | WriteResponse;
  error?: string;
  errorCode?: FormulaSafetyErrorCode;
  retryWith?: {
    overwrite_formulas: true;
  };
  alternatives?: string[];
  formulaCells?: FormulaCellRef[];
  updatedCells?: number;
  updatedRows?: number;
  updatedColumns?: number;
  clearedRange?: string;
}

export interface ListSheetsOptions {
  spreadsheetId: string;
}

export interface ExtractIdResult {
  success: boolean;
  spreadsheetId?: string;
  error?: string;
}

// Batch operations
export interface BatchGetValuesOptions {
  spreadsheetId: string;
  ranges: string[]; // Array of A1 notation ranges
  majorDimension?: 'ROWS' | 'COLUMNS';
  returnJson?: boolean;
  valueView?: ReadValueView;
  anchorMode?: AnchorMode;
  // continuationToken intentionally unsupported for batch reads in Phase 1.
}

export interface BatchUpdateValuesOptions {
  spreadsheetId: string;
  data: {
    range: string;
    values: CellValue[][];
  }[];
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  overwriteFormulas?: boolean;
}

export interface BatchValuesResult {
  range: string;
  values: CellValue[][];
}

export interface BatchShapedValuesResult {
  range: string;
  shaped: ShapedReadResponse;
}

export interface BatchAnchorValuesResult {
  range: string;
  anchor: AnchorReadResponse;
}

export interface BatchOperationResult {
  success: boolean;
  data?: Array<BatchValuesResult | BatchShapedValuesResult | BatchAnchorValuesResult>;
  error?: string;
  errorCode?: FormulaSafetyErrorCode;
  retryWith?: {
    overwrite_formulas: true;
  };
  alternatives?: string[];
  formulaCells?: FormulaCellRef[];
  warnings?: SuspiciousWriteWarning[];
  totalUpdatedCells?: number;
  totalUpdatedRows?: number;
  totalUpdatedSheets?: number;
}

// Find and replace
export interface FindReplaceOptions {
  spreadsheetId: string;
  find: string;
  replacement: string;
  sheetId?: number; // If omitted, searches all sheets
  matchCase?: boolean;
  matchEntireCell?: boolean;
  searchByRegex?: boolean;
  includeFormulas?: boolean;
}

export interface FindReplaceResult {
  success: boolean;
  error?: string;
  occurrencesChanged?: number;
  valuesChanged?: number;
  rowsChanged?: number;
  sheetsChanged?: number;
  formulasChanged?: number;
}

// Cell formatting
export interface CellColor {
  red?: number;   // 0.0 to 1.0
  green?: number; // 0.0 to 1.0
  blue?: number;  // 0.0 to 1.0
  alpha?: number; // 0.0 to 1.0
}

export type BorderStyle = 'NONE' | 'DOTTED' | 'DASHED' | 'SOLID' | 'SOLID_MEDIUM' | 'SOLID_THICK' | 'DOUBLE';

export interface FormatCellsOptions {
  spreadsheetId: string;
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number; // Exclusive
  startColumnIndex: number;
  endColumnIndex: number; // Exclusive
  // Text formatting
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  // Colors
  textColor?: CellColor;
  backgroundColor?: CellColor;
  // Borders (if any border property is set, applies to all sides unless specific sides are set)
  borderStyle?: BorderStyle;
  borderColor?: CellColor;
}

export interface FormatResult {
  success: boolean;
  error?: string;
  spreadsheetId?: string;
}
