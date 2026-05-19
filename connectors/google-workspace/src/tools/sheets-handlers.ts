import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getAccountManager, resolveEmail } from '../modules/accounts/index.js';
import { getSheetsService } from '../modules/sheets/index.js';
import { ActionableA1Error, normaliseA1Range } from '../modules/sheets/a1Utils.js';
import { rewriteSheetsApiError } from '../modules/sheets/errorRewriter.js';
import {
  extractSpreadsheetIdFromUrl,
  formatAnchorReadResponse,
  formatSpreadsheetAsText,
  formatOperationResult,
  formatShapedReadResponse,
  formatValuesAsTable,
  formatSheetsListAsText,
} from '../modules/sheets/formatters.js';
import {
  AnchorMode,
  AnchorReadResponse,
  ReadSpreadsheetOptions,
  ReadValueView,
  ReadValuesOptions,
  CreateSpreadsheetOptions,
  AppendValuesOptions,
  UpdateValuesOptions,
  ClearValuesOptions,
  AddSheetOptions,
  DeleteSheetOptions,
  ListSheetsOptions,
  SpreadsheetResponse,
  SheetInfo,
  BatchGetValuesOptions,
  BatchAnchorValuesResult,
  BatchValuesResult,
  BatchShapedValuesResult,
  BatchUpdateValuesOptions,
  FormulaOverwriteRefusal,
  FormulaSafetyErrorCode,
  FindReplaceOptions,
  FormatCellsOptions,
  CellColor,
  BorderStyle,
  ShapedReadResponse,
  WriteResponse,
} from '../modules/sheets/types.js';
import { McpToolResponse } from './types.js';
import {
  readAliasedBoolean,
  readAliasedNumber,
  readAliasedString,
  readAliasedValue
} from './arg-aliases.js';
import { wrapUntrustedJsonStrings } from '../utils/untrusted-content.js';

// Handler argument types
interface ReadSpreadsheetArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
  range?: string;
  max_rows?: number;
  maxRows?: number;
  max_cols?: number;
  maxCols?: number;
  return_json?: boolean;
  returnJson?: boolean;
  value_view?: ReadValueView;
  valueView?: ReadValueView;
  anchor_mode?: AnchorMode;
  anchorMode?: AnchorMode;
  continuation_token?: string;
  continuationToken?: string;
}

interface ReadValuesArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
  range: string;
  major_dimension?: 'ROWS' | 'COLUMNS';
  majorDimension?: 'ROWS' | 'COLUMNS';
  return_json?: boolean;
  returnJson?: boolean;
  value_view?: ReadValueView;
  valueView?: ReadValueView;
  anchor_mode?: AnchorMode;
  anchorMode?: AnchorMode;
  continuation_token?: string;
  continuationToken?: string;
}

interface CreateSpreadsheetArgs {
  email?: string;
  title: string;
  sheet_titles?: string[];
  sheetTitles?: string[];
}

interface AppendValuesArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
  range: string;
  values: (string | number | boolean | null)[][];
  value_input_option?: 'RAW' | 'USER_ENTERED';
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  overwrite_formulas?: boolean;
  overwriteFormulas?: boolean;
}

interface UpdateValuesArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
  range: string;
  values: (string | number | boolean | null)[][];
  value_input_option?: 'RAW' | 'USER_ENTERED';
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  overwrite_formulas?: boolean;
  overwriteFormulas?: boolean;
}

interface ClearValuesArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
  range: string;
}

interface ListSheetsArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
}

interface AddSheetArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
  title: string;
  row_count?: number;
  rowCount?: number;
  column_count?: number;
  columnCount?: number;
}

interface DeleteSheetArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
  sheet_id?: number;
  sheetId?: number;
}

interface ExtractIdArgs {
  input: string;
}

interface BatchGetValuesArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
  ranges: string[];
  major_dimension?: 'ROWS' | 'COLUMNS';
  majorDimension?: 'ROWS' | 'COLUMNS';
  return_json?: boolean;
  returnJson?: boolean;
  value_view?: ReadValueView;
  valueView?: ReadValueView;
  anchor_mode?: AnchorMode;
  anchorMode?: AnchorMode;
  continuation_token?: string;
  continuationToken?: string;
}

interface BatchUpdateValuesArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
  data: {
    range: string;
    values: (string | number | boolean | null)[][];
  }[];
  value_input_option?: 'RAW' | 'USER_ENTERED';
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  overwrite_formulas?: boolean;
  overwriteFormulas?: boolean;
}

interface FindReplaceArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
  range?: string;
  find: string;
  replacement: string;
  sheet_id?: number;
  sheetId?: number;
  match_case?: boolean;
  matchCase?: boolean;
  match_entire_cell?: boolean;
  matchEntireCell?: boolean;
  search_by_regex?: boolean;
  searchByRegex?: boolean;
  include_formulas?: boolean;
  includeFormulas?: boolean;
}

interface FormatCellsArgs {
  email?: string;
  spreadsheet_id?: string;
  spreadsheetId?: string;
  range?: string;
  sheet_id?: number;
  sheetId?: number;
  start_row_index?: number;
  startRowIndex?: number;
  end_row_index?: number;
  endRowIndex?: number;
  start_column_index?: number;
  startColumnIndex?: number;
  end_column_index?: number;
  endColumnIndex?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  font_size?: number;
  fontSize?: number;
  text_color?: CellColor;
  textColor?: CellColor;
  background_color?: CellColor;
  backgroundColor?: CellColor;
  border_style?: BorderStyle;
  borderStyle?: BorderStyle;
  border_color?: CellColor;
  borderColor?: CellColor;
}

function normaliseRangeOrThrow(range: string): string {
  try {
    return normaliseA1Range(range);
  } catch (error) {
    if (error instanceof ActionableA1Error) {
      throw new McpError(ErrorCode.InvalidRequest, `${error.message} ${error.suggestion}`);
    }
    throw error;
  }
}

function rewriteSheetsHandlerError(
  rawError: string | undefined,
  fallbackMessage: string,
  tool: string,
  input: Record<string, unknown>,
): string {
  return rewriteSheetsApiError(rawError || fallbackMessage, { tool, input });
}

function isAnchorReadResponse(data: unknown): data is AnchorReadResponse {
  return typeof data === 'object'
    && data !== null
    && 'firstRows' in data
    && 'columnSummary' in data
    && 'truncated' in data;
}

function isBatchAnchorValuesResult(data: unknown): data is BatchAnchorValuesResult {
  return typeof data === 'object'
    && data !== null
    && 'anchor' in data;
}

const FORMULA_SAFETY_ALTERNATIVES = [
  'Write to non-formula cells.',
  'Update formulas via Phase 2 set_formula tool when available.',
];

function isFormulaSafetyErrorCode(errorCode: unknown): errorCode is FormulaSafetyErrorCode {
  return errorCode === 'formula_overwrite_refused' || errorCode === 'formula_safety_unverifiable';
}

function buildFormulaRefusalToolResult(input: {
  errorCode: FormulaSafetyErrorCode;
  error?: string;
  retryWith?: { overwrite_formulas: true };
  alternatives?: string[];
  formulaCells?: Array<{ a1: string; formula: string; proposedValue: unknown }>;
}): McpToolResponse {
  const payload: FormulaOverwriteRefusal = {
    status: 'refused',
    error_code: input.errorCode,
    error: input.error || 'Write refused by formula safety guard.',
    retry_with: input.retryWith ?? { overwrite_formulas: true },
    alternatives: input.alternatives ?? FORMULA_SAFETY_ALTERNATIVES,
    formula_cells: input.formulaCells,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
    _meta: {},
  };
}

/**
 * Read spreadsheet metadata and optionally values
 */
export async function handleReadSpreadsheet(args: ReadSpreadsheetArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');
  const maxRows = readAliasedNumber(rawArgs, 'max_rows', 'maxRows');
  const maxCols = readAliasedNumber(rawArgs, 'max_cols', 'maxCols');
  const returnJson = readAliasedBoolean(rawArgs, 'return_json', 'returnJson');
  const valueView = readAliasedValue<ReadValueView>(rawArgs, 'value_view', 'valueView');
  const anchorMode = readAliasedValue<AnchorMode>(rawArgs, 'anchor_mode', 'anchorMode');
  const continuationToken = readAliasedString(rawArgs, 'continuation_token', 'continuationToken');

  if (typeof args.range === 'string') {
    args.range = normaliseRangeOrThrow(args.range);
  }
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: ReadSpreadsheetOptions = {
      range: args.range,
      maxRows,
      maxCols,
      returnJson,
      valueView,
      anchorMode,
      continuationToken,
    };
    
    const result = await sheetsService.getSpreadsheet(email, spreadsheetId as string, options);
    
    if (!result.success || !result.data) {
      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to read spreadsheet', 'read_workspace_spreadsheet', rawArgs),
      );
    }
    
    if (returnJson) {
      return wrapUntrustedJsonStrings(result.data, `google-workspace:sheets:spreadsheet/${spreadsheetId}`);
    }
    
    // Format as human-readable text
    const response = result.data as SpreadsheetResponse;
    if (valueView === 'shaped' && response.shapedValues) {
      const metadataOnly: SpreadsheetResponse = {
        ...response,
        values: undefined,
        shapedValues: undefined,
      };
      return `${formatSpreadsheetAsText(metadataOnly)}\n\nData:\n${formatShapedReadResponse(response.shapedValues)}`;
    }

    if (response.anchorValues) {
      const metadataOnly: SpreadsheetResponse = {
        ...response,
        values: undefined,
        shapedValues: undefined,
        anchorValues: undefined,
      };
      return `${formatSpreadsheetAsText(metadataOnly)}\n\nData:\n${formatAnchorReadResponse(response.anchorValues)}`;
    }

    return formatSpreadsheetAsText(response);
  });
}

/**
 * Read values from a specific range
 */
export async function handleReadSpreadsheetValues(args: ReadValuesArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');
  const majorDimension = readAliasedValue<'ROWS' | 'COLUMNS'>(rawArgs, 'major_dimension', 'majorDimension');
  const returnJson = readAliasedBoolean(rawArgs, 'return_json', 'returnJson');
  const valueView = readAliasedValue<ReadValueView>(rawArgs, 'value_view', 'valueView');
  const anchorMode = readAliasedValue<AnchorMode>(rawArgs, 'anchor_mode', 'anchorMode');
  const continuationToken = readAliasedString(rawArgs, 'continuation_token', 'continuationToken');

  args.range = normaliseRangeOrThrow(args.range);
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: ReadValuesOptions = {
      range: args.range,
      majorDimension,
      returnJson,
      valueView,
      anchorMode,
      continuationToken,
    };

    const result = valueView === 'shaped'
      ? await sheetsService.getShapedValues(email, spreadsheetId as string, options)
      : await sheetsService.getValues(email, spreadsheetId as string, options);
    
    if (!result.success || !result.data) {
      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to read spreadsheet values', 'read_workspace_spreadsheet_values', rawArgs),
      );
    }
    
    if (returnJson) {
      return wrapUntrustedJsonStrings(result.data, `google-workspace:sheets:values/${spreadsheetId}`);
    }

    if (isAnchorReadResponse(result.data)) {
      return formatAnchorReadResponse(result.data);
    }

    if (valueView === 'shaped') {
      return formatShapedReadResponse(result.data as ShapedReadResponse);
    }
    
    // Format as human-readable text
    const response = result.data as SpreadsheetResponse;
    const header = `Range: ${args.range}\nSpreadsheet: ${response.spreadsheetUrl}\n---\n`;
    const table = formatValuesAsTable(response.values);
    return header + table;
  });
}

/**
 * Create a new spreadsheet
 */
export async function handleCreateSpreadsheet(args: CreateSpreadsheetArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const sheetTitles = readAliasedValue<string[]>(rawArgs, 'sheet_titles', 'sheetTitles');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: CreateSpreadsheetOptions = {
      title: args.title,
      sheetTitles,
    };
    
    const result = await sheetsService.createSpreadsheet(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to create spreadsheet', 'create_workspace_spreadsheet', rawArgs),
      );
    }
    
    const response = result.data as SpreadsheetResponse;
    let message = `Spreadsheet created successfully!\n\nTitle: ${response.title}\nURL: ${response.spreadsheetUrl}\nID: ${response.spreadsheetId}`;
    
    if (response.sheets && response.sheets.length > 0) {
      message += `\nSheets: ${response.sheets.map(s => s.title).join(', ')}`;
    }
    
    return message;
  });
}

/**
 * Append values to a spreadsheet
 */
export async function handleAppendValues(args: AppendValuesArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');
  const valueInputOption = readAliasedValue<'RAW' | 'USER_ENTERED'>(rawArgs, 'value_input_option', 'valueInputOption');
  const overwriteFormulas = readAliasedBoolean(rawArgs, 'overwrite_formulas', 'overwriteFormulas');

  args.range = normaliseRangeOrThrow(args.range);
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: AppendValuesOptions = {
      spreadsheetId: spreadsheetId as string,
      range: args.range,
      values: args.values,
      valueInputOption,
      overwriteFormulas,
    };
    
    const result = await sheetsService.appendValues(email, options);
    
    if (!result.success) {
      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to append values', 'append_to_workspace_spreadsheet', rawArgs),
      );
    }
    
    const writeResponse = result.data as WriteResponse | undefined;
    return formatOperationResult('Append', spreadsheetId as string, {
      updatedCells: result.updatedCells,
      updatedRows: result.updatedRows,
      warnings: writeResponse?.warnings,
    });
  });
}

/**
 * Update values in a specific range
 */
export async function handleUpdateValues(args: UpdateValuesArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');
  const valueInputOption = readAliasedValue<'RAW' | 'USER_ENTERED'>(rawArgs, 'value_input_option', 'valueInputOption');
  const overwriteFormulas = readAliasedBoolean(rawArgs, 'overwrite_formulas', 'overwriteFormulas');

  args.range = normaliseRangeOrThrow(args.range);
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: UpdateValuesOptions = {
      spreadsheetId: spreadsheetId as string,
      range: args.range,
      values: args.values,
      valueInputOption,
      overwriteFormulas,
    };
    
    const result = await sheetsService.updateValues(email, options);
    
    if (!result.success) {
      if (isFormulaSafetyErrorCode(result.errorCode)) {
        return buildFormulaRefusalToolResult({
          errorCode: result.errorCode,
          error: result.error,
          retryWith: result.retryWith,
          alternatives: result.alternatives,
          formulaCells: result.formulaCells,
        });
      }

      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to update values', 'update_workspace_spreadsheet_values', rawArgs),
      );
    }
    
    const writeResponse = result.data as WriteResponse | undefined;
    return formatOperationResult('Update', spreadsheetId as string, {
      updatedCells: result.updatedCells,
      updatedRows: result.updatedRows,
      warnings: writeResponse?.warnings,
    });
  });
}

/**
 * Clear values from a range
 */
export async function handleClearValues(args: ClearValuesArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');

  args.range = normaliseRangeOrThrow(args.range);
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: ClearValuesOptions = {
      spreadsheetId: spreadsheetId as string,
      range: args.range,
    };
    
    const result = await sheetsService.clearValues(email, options);
    
    if (!result.success) {
      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to clear values', 'clear_workspace_spreadsheet_values', rawArgs),
      );
    }
    
    return formatOperationResult('Clear', spreadsheetId as string, {
      clearedRange: result.clearedRange,
    });
  });
}

/**
 * List sheets in a spreadsheet
 */
export async function handleListSheets(args: ListSheetsArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: ListSheetsOptions = {
      spreadsheetId: spreadsheetId as string,
    };
    
    const result = await sheetsService.listSheets(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to list sheets', 'list_workspace_spreadsheet_sheets', rawArgs),
      );
    }
    
    const response = result.data as SpreadsheetResponse;
    const header = `Spreadsheet: ${response.title}\nURL: ${response.spreadsheetUrl}\n---\n`;
    const sheetsList = formatSheetsListAsText(response.sheets || []);
    return header + sheetsList;
  });
}

/**
 * Add a new sheet to a spreadsheet
 */
export async function handleAddSheet(args: AddSheetArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');
  const rowCount = readAliasedNumber(rawArgs, 'row_count', 'rowCount');
  const columnCount = readAliasedNumber(rawArgs, 'column_count', 'columnCount');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: AddSheetOptions = {
      spreadsheetId: spreadsheetId as string,
      title: args.title,
      rowCount,
      columnCount,
    };
    
    const result = await sheetsService.addSheet(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to add sheet', 'add_workspace_spreadsheet_sheet', rawArgs),
      );
    }
    
    const sheetInfo = result.data as SheetInfo;
    return formatOperationResult('Add sheet', spreadsheetId as string, {
      sheetTitle: sheetInfo.title,
    }) + `\nSheet ID: ${sheetInfo.sheetId}`;
  });
}

/**
 * Delete a sheet from a spreadsheet
 */
export async function handleDeleteSheet(args: DeleteSheetArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');
  const sheetId = readAliasedNumber(rawArgs, 'sheet_id', 'sheetId');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: DeleteSheetOptions = {
      spreadsheetId: spreadsheetId as string,
      sheetId: sheetId as number,
    };
    
    const result = await sheetsService.deleteSheet(email, options);
    
    if (!result.success) {
      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to delete sheet', 'delete_workspace_spreadsheet_sheet', rawArgs),
      );
    }
    
    return `Sheet deleted successfully!\n\nSpreadsheet URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit\nDeleted sheet ID: ${sheetId}`;
  });
}

/**
 * Extract spreadsheet ID from URL or validate existing ID
 */
export async function handleExtractSpreadsheetId(args: ExtractIdArgs): Promise<McpToolResponse | string | object> {
  const spreadsheetId = extractSpreadsheetIdFromUrl(args.input);
  
  if (!spreadsheetId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Could not extract spreadsheet ID from input: "${args.input}". Expected a Google Sheets URL (e.g., https://docs.google.com/spreadsheets/d/{id}/edit) or a valid spreadsheet ID.`
    );
  }
  
  return `Spreadsheet ID: ${spreadsheetId}`;
}

/**
 * Batch read values from multiple ranges in a single API call
 */
export async function handleBatchGetValues(args: BatchGetValuesArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');
  const majorDimension = readAliasedValue<'ROWS' | 'COLUMNS'>(rawArgs, 'major_dimension', 'majorDimension');
  const returnJson = readAliasedBoolean(rawArgs, 'return_json', 'returnJson');
  const valueView = readAliasedValue<ReadValueView>(rawArgs, 'value_view', 'valueView');
  const anchorMode = readAliasedValue<AnchorMode>(rawArgs, 'anchor_mode', 'anchorMode');
  const continuationToken = readAliasedString(rawArgs, 'continuation_token', 'continuationToken');

  if (continuationToken) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `continuation_token is not supported for batch_read_workspace_spreadsheet_values in Phase 1. Re-run single-range read_workspace_spreadsheet_values with the token, or issue a fresh batch read without continuation_token.`,
    );
  }

  args.ranges = args.ranges.map((range) => normaliseRangeOrThrow(range));
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: BatchGetValuesOptions = {
      spreadsheetId: spreadsheetId as string,
      ranges: args.ranges,
      majorDimension,
      returnJson,
      valueView,
      anchorMode,
    };

    const result = valueView === 'shaped'
      ? await sheetsService.batchGetShapedValues(email, options)
      : await sheetsService.batchGetValues(email, options);
    
    if (!result.success || !result.data) {
      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to batch read values', 'batch_read_workspace_spreadsheet_values', rawArgs),
      );
    }
    
    if (returnJson) {
      return wrapUntrustedJsonStrings(result.data, `google-workspace:sheets:batch/${spreadsheetId}`);
    }

    if (valueView === 'shaped') {
      const shapedRanges = result.data as Array<BatchShapedValuesResult | BatchAnchorValuesResult>;
      let output = `Batch Read: ${args.ranges.length} range(s)\nSpreadsheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit\n`;
      for (const rangeData of shapedRanges) {
        output += `\n--- ${rangeData.range} ---\n`;
        if (isBatchAnchorValuesResult(rangeData)) {
          output += formatAnchorReadResponse(rangeData.anchor);
        } else {
          output += formatShapedReadResponse(rangeData.shaped);
        }
      }
      return output;
    }
    
    // Format as human-readable text with all ranges
    const valueRanges = result.data as Array<BatchValuesResult | BatchAnchorValuesResult>;
    let output = `Batch Read: ${args.ranges.length} range(s)\nSpreadsheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit\n`;
    
    for (const rangeData of valueRanges) {
      output += `\n--- ${rangeData.range} ---\n`;
      if (isBatchAnchorValuesResult(rangeData)) {
        output += formatAnchorReadResponse(rangeData.anchor);
      } else {
        output += formatValuesAsTable(rangeData.values);
      }
    }
    
    return output;
  });
}

/**
 * Batch update values in multiple ranges in a single API call
 */
export async function handleBatchUpdateValues(args: BatchUpdateValuesArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');
  const valueInputOption = readAliasedValue<'RAW' | 'USER_ENTERED'>(rawArgs, 'value_input_option', 'valueInputOption');
  const overwriteFormulas = readAliasedBoolean(rawArgs, 'overwrite_formulas', 'overwriteFormulas');

  args.data = args.data.map((entry) => ({
    ...entry,
    range: normaliseRangeOrThrow(entry.range),
  }));
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: BatchUpdateValuesOptions = {
      spreadsheetId: spreadsheetId as string,
      data: args.data,
      valueInputOption,
      overwriteFormulas,
    };
    
    const result = await sheetsService.batchUpdateValues(email, options);
    
    if (!result.success) {
      if (isFormulaSafetyErrorCode(result.errorCode)) {
        return buildFormulaRefusalToolResult({
          errorCode: result.errorCode,
          error: result.error,
          retryWith: result.retryWith,
          alternatives: result.alternatives,
          formulaCells: result.formulaCells,
        });
      }

      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to batch update values', 'batch_update_workspace_spreadsheet_values', rawArgs),
      );
    }
    
    const ranges = args.data.map(d => d.range).join(', ');
    let response = `Batch update completed successfully!\n\nSpreadsheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit\nRanges updated: ${ranges}\nTotal cells updated: ${result.totalUpdatedCells ?? 0}\nTotal rows updated: ${result.totalUpdatedRows ?? 0}\nTotal sheets affected: ${result.totalUpdatedSheets ?? 0}`;
    if (result.warnings && result.warnings.length > 0) {
      response += `\n\nWarnings:\n${result.warnings.map((warning) => `- ${warning.detail}`).join('\n')}`;
    }

    return response;
  });
}

/**
 * Find and replace text throughout a spreadsheet or specific sheet
 */
export async function handleFindReplace(args: FindReplaceArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');
  const sheetId = readAliasedNumber(rawArgs, 'sheet_id', 'sheetId');
  const matchCase = readAliasedBoolean(rawArgs, 'match_case', 'matchCase');
  const matchEntireCell = readAliasedBoolean(rawArgs, 'match_entire_cell', 'matchEntireCell');
  const searchByRegex = readAliasedBoolean(rawArgs, 'search_by_regex', 'searchByRegex');
  const includeFormulas = readAliasedBoolean(rawArgs, 'include_formulas', 'includeFormulas');

  if (typeof args.range === 'string') {
    args.range = normaliseRangeOrThrow(args.range);
  }
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: FindReplaceOptions = {
      spreadsheetId: spreadsheetId as string,
      find: args.find,
      replacement: args.replacement,
      sheetId,
      matchCase,
      matchEntireCell,
      searchByRegex,
      includeFormulas,
    };
    
    const result = await sheetsService.findAndReplace(email, options);
    
    if (!result.success) {
      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to find and replace', 'find_and_replace_workspace_spreadsheet', rawArgs),
      );
    }
    
    const scope = sheetId !== undefined ? `sheet ID ${sheetId}` : 'all sheets';
    return `Find and replace completed!\n\nSpreadsheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit\nScope: ${scope}\nFind: "${args.find}"\nReplace: "${args.replacement}"\n\nOccurrences changed: ${result.occurrencesChanged ?? 0}\nValues changed: ${result.valuesChanged ?? 0}\nRows changed: ${result.rowsChanged ?? 0}\nSheets changed: ${result.sheetsChanged ?? 0}\nFormulas changed: ${result.formulasChanged ?? 0}`;
  });
}

/**
 * Format cells (bold, colors, borders)
 */
export async function handleFormatCells(args: FormatCellsArgs): Promise<McpToolResponse | string | object> {
  const accountManager = getAccountManager();
  const rawArgs = args as unknown as Record<string, unknown>;
  const spreadsheetId = readAliasedString(rawArgs, 'spreadsheet_id', 'spreadsheetId');
  const sheetId = readAliasedNumber(rawArgs, 'sheet_id', 'sheetId');
  const startRowIndex = readAliasedNumber(rawArgs, 'start_row_index', 'startRowIndex');
  const endRowIndex = readAliasedNumber(rawArgs, 'end_row_index', 'endRowIndex');
  const startColumnIndex = readAliasedNumber(rawArgs, 'start_column_index', 'startColumnIndex');
  const endColumnIndex = readAliasedNumber(rawArgs, 'end_column_index', 'endColumnIndex');
  const fontSize = readAliasedNumber(rawArgs, 'font_size', 'fontSize');
  const textColor = readAliasedValue<CellColor>(rawArgs, 'text_color', 'textColor');
  const backgroundColor = readAliasedValue<CellColor>(rawArgs, 'background_color', 'backgroundColor');
  const borderStyle = readAliasedValue<BorderStyle>(rawArgs, 'border_style', 'borderStyle');
  const borderColor = readAliasedValue<CellColor>(rawArgs, 'border_color', 'borderColor');

  if (typeof args.range === 'string') {
    args.range = normaliseRangeOrThrow(args.range);
  }
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(args);
  
  return await accountManager.withTokenRenewal(email, async () => {
    const sheetsService = getSheetsService();
    
    const options: FormatCellsOptions = {
      spreadsheetId: spreadsheetId as string,
      sheetId: sheetId as number,
      startRowIndex: startRowIndex as number,
      endRowIndex: endRowIndex as number,
      startColumnIndex: startColumnIndex as number,
      endColumnIndex: endColumnIndex as number,
      bold: args.bold,
      italic: args.italic,
      underline: args.underline,
      strikethrough: args.strikethrough,
      fontSize,
      textColor,
      backgroundColor,
      borderStyle,
      borderColor,
    };
    
    const result = await sheetsService.formatCells(email, options);
    
    if (!result.success) {
      throw new McpError(
        ErrorCode.InternalError,
        rewriteSheetsHandlerError(result.error, 'Failed to format cells', 'format_workspace_spreadsheet_cells', rawArgs),
      );
    }
    
    // Build a description of applied formatting (check for explicit values, not truthy)
    const formatOpts: string[] = [];
    if (args.bold !== undefined) formatOpts.push(args.bold ? 'bold' : 'bold=false');
    if (args.italic !== undefined) formatOpts.push(args.italic ? 'italic' : 'italic=false');
    if (args.underline !== undefined) formatOpts.push(args.underline ? 'underline' : 'underline=false');
    if (args.strikethrough !== undefined) formatOpts.push(args.strikethrough ? 'strikethrough' : 'strikethrough=false');
    if (fontSize !== undefined) formatOpts.push(`font_size=${fontSize}`);
    if (textColor !== undefined) formatOpts.push('text_color');
    if (backgroundColor !== undefined) formatOpts.push('background_color');
    if (borderStyle !== undefined || borderColor !== undefined) formatOpts.push('borders');
    
    const rangeDesc = `rows ${(startRowIndex as number)}-${(endRowIndex as number) - 1}, cols ${(startColumnIndex as number)}-${(endColumnIndex as number) - 1}`;
    return `Formatting applied successfully!\n\nSpreadsheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit\nSheet ID: ${sheetId}\nRange: ${rangeDesc} (0-based indices)\nFormatting: ${formatOpts.join(', ') || 'none specified'}`;
  });
}
