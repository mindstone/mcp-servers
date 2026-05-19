import { google, sheets_v4 } from 'googleapis';
import { BaseGoogleService } from '../../services/base/BaseGoogleService.js';
import {
  AnchorMode,
  AnchorReadResponse,
  ContinuationTokenPayload,
  FormulaSafetyErrorCode,
  SheetsOperationResult,
  ReadSpreadsheetOptions,
  ReadValuesOptions,
  ReadValueView,
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
  BatchUpdateValuesOptions,
  BatchOperationResult,
  BatchShapedValuesResult,
  BatchAnchorValuesResult,
  BatchValuesResult,
  CellTriad,
  CellValue,
  FindReplaceOptions,
  FindReplaceResult,
  FormatCellsOptions,
  FormatResult,
  ShapedReadResponse,
  ShapedWarning,
  WriteResponse,
} from './types.js';
import { SHEETS_SCOPES } from './scopes.js';
import {
  buildAnchorEnvelope,
  buildShapedReadResponse,
  ContinuationTokenError,
  mergeFormulaAndValue,
  parseContinuationToken,
} from './cellShape.js';
import { rewriteSheetsApiError } from './errorRewriter.js';
import { parseA1Range, quoteSheetNameIfNeeded, rowCountFromA1 } from './a1Utils.js';
import {
  detectFormulaOverwrite,
  detectRawFormulaLiterals,
  detectSuspiciousWrites,
  ExistingFormulaCell,
  SuspiciousWriteWarning,
} from './writeGuards.js';
import logger from '../../utils/logger.js';

const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_MAX_COLS = 26; // A-Z
const ANCHOR_FIRST_ROWS = 50;
const ANCHOR_LAST_ROWS = 10;

interface SheetGridContext {
  sheetId?: number;
  sheetTitle: string;
  sheetRowCount: number;
  rangeRowCount: number;
  columnCount: number;
  startRow: number;
  endRow: number;
  startCol: string;
  endCol: string;
}

interface WindowRange {
  a1: string;
  startRow: number;
  endRow: number;
}

interface FormulaPreReadResult {
  formulaCells: ExistingFormulaCell[];
  error?: string;
  errorKind?: 'permission' | 'transient' | 'unknown';
}

export class SheetsService extends BaseGoogleService<sheets_v4.Sheets> {
  private initialized = false;

  constructor() {
    super({
      serviceName: 'Google Sheets',
      version: 'v4',
    });
  }

  public async initialize(): Promise<void> {
    try {
      await super.initialize();
      this.initialized = true;
    } catch (error) {
      throw this.handleError(error, 'Failed to initialize Sheets service');
    }
  }

  public async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private checkInitialized(): void {
    if (!this.initialized) {
      throw this.handleError(
        new Error('Sheets service not initialized'),
        'Please ensure the service is initialized before use'
      );
    }
  }

  /**
   * Construct a Google Sheets URL from spreadsheet ID
   */
  private constructSpreadsheetUrl(spreadsheetId: string): string {
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  }

  /**
   * Extract sheet info from sheet properties
   */
  private extractSheetInfo(sheet: sheets_v4.Schema$Sheet): SheetInfo {
    const props = sheet.properties || {};
    return {
      sheetId: props.sheetId ?? 0,
      title: props.title || 'Untitled Sheet',
      index: props.index ?? 0,
      rowCount: props.gridProperties?.rowCount ?? undefined,
      columnCount: props.gridProperties?.columnCount ?? undefined,
    };
  }

  private resolveValueRenderOption(valueView?: ReadValueView): sheets_v4.Params$Resource$Spreadsheets$Values$Get['valueRenderOption'] | undefined {
    if (valueView === 'formula') {
      return 'FORMULA';
    }

    if (valueView === 'unformatted') {
      return 'UNFORMATTED_VALUE';
    }

    return undefined;
  }

  private toCellMatrix(values: sheets_v4.Schema$ValueRange['values']): CellValue[][] | undefined {
    return values as CellValue[][] | undefined;
  }

  private buildFormulaFallbackWarning(rawError: unknown, tool: string, input: Record<string, unknown>): ShapedWarning {
    return {
      kind: 'mixed_column_types',
      message: 'Formula data unavailable due to API error; cells show formatted values only',
      detail: {
        formulaError: rewriteSheetsApiError(rawError, { tool, input }),
      },
    };
  }

  private isAnchorReadResponse(data: unknown): data is AnchorReadResponse {
    return typeof data === 'object'
      && data !== null
      && 'firstRows' in data
      && 'columnSummary' in data
      && 'truncated' in data;
  }

  private shouldUseAnchor(options: {
    anchorMode?: AnchorMode;
    continuationToken?: string;
    range: string;
  }): boolean {
    if (options.continuationToken) {
      return false;
    }

    if (options.anchorMode === 'always') {
      return true;
    }

    if (options.anchorMode === 'never') {
      return false;
    }

    const parsed = parseA1Range(options.range);
    if (parsed?.isUnbounded) {
      return true;
    }

    const boundedRowCount = rowCountFromA1(options.range);
    return boundedRowCount !== null && boundedRowCount >= DEFAULT_MAX_ROWS;
  }

  private canUseAnchorEnvelope(options: { returnJson?: boolean; anchorMode?: AnchorMode; internalCall?: boolean }): boolean {
    if (options.internalCall) {
      return true;
    }

    if (!options.returnJson) {
      return true;
    }
    return options.anchorMode === 'always';
  }

  private columnLetterToIndex(columnLetter: string): number {
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

  private columnIndexToLetter(columnIndex: number): string {
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

  private toCellTriadMatrix(values: CellValue[][] | undefined, valueView?: ReadValueView): CellTriad[][] {
    const matrix = values ?? [];
    return matrix.map((row) =>
      row.map((value) => {
        if (valueView === 'formula' && typeof value === 'string' && value.trim().startsWith('=')) {
          return { value: null, formula: value };
        }
        return { value: value ?? null };
      }),
    );
  }

  private isEmptyTriadCell(cell: CellTriad): boolean {
    if (cell.formula) {
      return false;
    }

    if (cell.value === null || cell.value === undefined) {
      return true;
    }

    return typeof cell.value === 'string' && cell.value.trim() === '';
  }

  private computeNextEmptyRow(
    firstWindow: CellTriad[][],
    firstWindowStartRow: number,
    lastWindow?: CellTriad[][],
    lastWindowStartRow?: number,
  ): number | undefined {
    const activeWindow = lastWindow && lastWindow.length > 0 ? lastWindow : firstWindow;
    const activeStartRow = lastWindow && lastWindow.length > 0
      ? (lastWindowStartRow ?? firstWindowStartRow)
      : firstWindowStartRow;

    for (let index = activeWindow.length - 1; index >= 0; index -= 1) {
      const row = activeWindow[index];
      const hasContent = row.some((cell) => !this.isEmptyTriadCell(cell));
      if (hasContent) {
        return activeStartRow + index + 1;
      }
    }

    return activeStartRow;
  }

  private buildA1WindowRange(
    sheetTitle: string,
    startCol: string,
    endCol: string,
    startRow: number,
    endRow: number,
  ): WindowRange {
    const normalizedSheetName = quoteSheetNameIfNeeded(sheetTitle);
    return {
      a1: `${normalizedSheetName}!${startCol}${startRow}:${endCol}${endRow}`,
      startRow,
      endRow,
    };
  }

  private resolveSheetGridContext(
    metadata: sheets_v4.Schema$Spreadsheet,
    range: string,
  ): SheetGridContext {
    const parsed = parseA1Range(range);
    const allSheets = metadata.sheets ?? [];
    const requestedSheetName = parsed?.sheetName;

    const targetSheet = requestedSheetName
      ? allSheets.find((sheet) => sheet.properties?.title === requestedSheetName)
      : allSheets[0];

    if (!targetSheet?.properties?.title) {
      throw new Error(
        requestedSheetName
          ? `Unable to resolve sheet '${requestedSheetName}' for range '${range}'.`
          : `Unable to resolve target sheet for range '${range}'.`,
      );
    }

    const gridRowCount = Math.max(1, targetSheet.properties.gridProperties?.rowCount ?? DEFAULT_MAX_ROWS);
    const gridColumnCount = Math.max(1, targetSheet.properties.gridProperties?.columnCount ?? DEFAULT_MAX_COLS);
    const safeColumnCount = Math.max(1, Math.min(gridColumnCount, DEFAULT_MAX_COLS));

    const startRow = Math.max(1, parsed?.startRow ?? 1);
    const unclampedEndRow = parsed?.endRow ?? gridRowCount;
    const endRow = Math.max(startRow, Math.min(unclampedEndRow, gridRowCount));

    const startCol = (parsed?.startCol ?? 'A').toUpperCase();
    const startColIndex = this.columnLetterToIndex(startCol) || 1;
    const endCol = parsed?.endCol?.toUpperCase()
      ?? this.columnIndexToLetter(startColIndex + safeColumnCount - 1);
    const endColIndex = this.columnLetterToIndex(endCol) || startColIndex;
    const columnCount = Math.max(1, endColIndex - startColIndex + 1);

    return {
      sheetId: targetSheet.properties.sheetId ?? undefined,
      sheetTitle: targetSheet.properties.title,
      sheetRowCount: gridRowCount,
      rangeRowCount: endRow - startRow + 1,
      columnCount,
      startRow,
      endRow,
      startCol,
      endCol,
    };
  }

  private async readAnchorWindow(
    client: sheets_v4.Sheets,
    spreadsheetId: string,
    range: WindowRange,
    valueView?: ReadValueView,
  ): Promise<{ cells: CellTriad[][]; warnings: ShapedWarning[] }> {
    if (valueView === 'shaped') {
      const [formattedResult, formulaResult] = await Promise.allSettled([
        client.spreadsheets.values.get({
          spreadsheetId,
          range: range.a1,
          majorDimension: 'ROWS',
          valueRenderOption: 'FORMATTED_VALUE',
        }),
        client.spreadsheets.values.get({
          spreadsheetId,
          range: range.a1,
          majorDimension: 'ROWS',
          valueRenderOption: 'FORMULA',
        }),
      ]);

      if (formattedResult.status === 'rejected') {
        throw formattedResult.reason;
      }

      const formattedValues = this.toCellMatrix(formattedResult.value.data.values);
      let formulaValues: CellValue[][] | undefined;
      const warnings: ShapedWarning[] = [];

      if (formulaResult.status === 'fulfilled') {
        formulaValues = this.toCellMatrix(formulaResult.value.data.values);
      } else {
        warnings.push(
          this.buildFormulaFallbackWarning(
            formulaResult.reason,
            'read_workspace_spreadsheet_values',
            { spreadsheet_id: spreadsheetId, range: range.a1 },
          ),
        );
      }

      return {
        cells: mergeFormulaAndValue(formattedValues, formulaValues),
        warnings,
      };
    }

    const valueRenderOption = this.resolveValueRenderOption(valueView);
    const response = await client.spreadsheets.values.get({
      spreadsheetId,
      range: range.a1,
      majorDimension: 'ROWS',
      valueRenderOption,
    });

    return {
      cells: this.toCellTriadMatrix(this.toCellMatrix(response.data.values), valueView),
      warnings: [],
    };
  }

  private async getAnchorRead(
    email: string,
    spreadsheetId: string,
    options: ReadValuesOptions,
  ): Promise<SheetsOperationResult> {
    await this.ensureInitialized();
    this.checkInitialized();
    await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

    const client = await this.getAuthenticatedClient(email, (auth) =>
      google.sheets({ version: 'v4', auth }),
    );

    const metadataResponse = await client.spreadsheets.get({
      spreadsheetId,
      fields: 'spreadsheetId,sheets.properties(sheetId,title,gridProperties)',
    });

    const context = this.resolveSheetGridContext(metadataResponse.data, options.range);
    const firstWindowEnd = Math.min(
      context.endRow,
      context.startRow + ANCHOR_FIRST_ROWS - 1,
    );
    const firstWindowRange = this.buildA1WindowRange(
      context.sheetTitle,
      context.startCol,
      context.endCol,
      context.startRow,
      firstWindowEnd,
    );

    const remainingRows = context.endRow - firstWindowEnd;
    const hasTailWindow = remainingRows > 0;
    const tailStartRow = hasTailWindow
      ? Math.max(firstWindowEnd + 1, context.endRow - ANCHOR_LAST_ROWS + 1)
      : undefined;
    const tailRange = hasTailWindow && tailStartRow !== undefined
      ? this.buildA1WindowRange(
          context.sheetTitle,
          context.startCol,
          context.endCol,
          tailStartRow,
          context.endRow,
        )
      : undefined;

    const [firstWindow, lastWindow] = await Promise.all([
      this.readAnchorWindow(client, spreadsheetId, firstWindowRange, options.valueView),
      tailRange ? this.readAnchorWindow(client, spreadsheetId, tailRange, options.valueView) : Promise.resolve(undefined),
    ]);

    const warnings = [
      ...firstWindow.warnings,
      ...(lastWindow?.warnings ?? []),
    ];

    const nextEmptyRow = this.computeNextEmptyRow(
      firstWindow.cells,
      firstWindowRange.startRow,
      lastWindow?.cells,
      tailRange?.startRow,
    );

    const envelope = buildAnchorEnvelope({
      range: options.range,
      firstWindow: firstWindow.cells,
      firstWindowStartRow: firstWindowRange.startRow,
      lastWindow: lastWindow?.cells,
      lastWindowStartRow: tailRange?.startRow,
      totalRowCount: context.rangeRowCount,
      rowCountAtIssue: context.sheetRowCount,
      columnCount: context.columnCount,
      spreadsheetId,
      sheetId: context.sheetId,
      sheetTitle: context.sheetTitle,
      nextEmptyRow,
      warnings,
    });

    return {
      success: true,
      data: envelope,
    };
  }

  private continuationPayloadToRange(payload: ContinuationTokenPayload): string {
    const startCol = payload.startCol ?? 'A';
    const endCol = payload.endCol ?? startCol;
    const sheet = payload.sheet ? quoteSheetNameIfNeeded(payload.sheet) : undefined;
    const rowRange = `${startCol}${payload.startRow}:${endCol}${payload.endRow}`;
    return sheet ? `${sheet}!${rowRange}` : rowRange;
  }

  private async getContinuationPage(
    email: string,
    spreadsheetId: string,
    options: ReadValuesOptions,
  ): Promise<SheetsOperationResult> {
    await this.ensureInitialized();
    this.checkInitialized();
    await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

    const token = options.continuationToken;
    if (!token) {
      throw new ContinuationTokenError(
        'Missing continuation token.',
        `Pass continuation_token from an anchor envelope response.`,
      );
    }

    const client = await this.getAuthenticatedClient(email, (auth) =>
      google.sheets({ version: 'v4', auth }),
    );

    const parsedWithoutDrift = parseContinuationToken(token, { spreadsheetId });
    const metadataResponse = await client.spreadsheets.get({
      spreadsheetId,
      fields: 'spreadsheetId,sheets.properties(sheetId,title,gridProperties)',
    });
    const sheets = metadataResponse.data.sheets ?? [];
    const targetSheet = parsedWithoutDrift.sheetId !== undefined
      ? sheets.find((sheet) => sheet.properties?.sheetId === parsedWithoutDrift.sheetId)
      : (parsedWithoutDrift.sheet
        ? sheets.find((sheet) => sheet.properties?.title === parsedWithoutDrift.sheet)
        : sheets[0]);

    const currentRowCount = Math.max(1, targetSheet?.properties?.gridProperties?.rowCount ?? 0);
    const payload = parseContinuationToken(token, { spreadsheetId, currentRowCount });

    if (payload.sheetId !== undefined && targetSheet?.properties?.sheetId !== payload.sheetId) {
      throw new ContinuationTokenError(
        'Continuation token targets a different sheet than the current request.',
        `Issue a fresh read with anchor_mode='always' for the target sheet.`,
      );
    }

    const sheetTitle = targetSheet?.properties?.title ?? payload.sheet;
    const continuationRange = sheetTitle
      ? `${quoteSheetNameIfNeeded(sheetTitle)}!${payload.startCol ?? 'A'}${payload.startRow}:${payload.endCol ?? (payload.startCol ?? 'A')}${payload.endRow}`
      : this.continuationPayloadToRange(payload);

    if (options.valueView === 'shaped') {
      const [formattedResult, formulaResult] = await Promise.allSettled([
        client.spreadsheets.values.get({
          spreadsheetId,
          range: continuationRange,
          majorDimension: options.majorDimension || 'ROWS',
          valueRenderOption: 'FORMATTED_VALUE',
        }),
        client.spreadsheets.values.get({
          spreadsheetId,
          range: continuationRange,
          majorDimension: options.majorDimension || 'ROWS',
          valueRenderOption: 'FORMULA',
        }),
      ]);

      if (formattedResult.status === 'rejected') {
        throw formattedResult.reason;
      }

      const shaped = buildShapedReadResponse(
        formattedResult.value.data.range || continuationRange,
        this.toCellMatrix(formattedResult.value.data.values),
        formulaResult.status === 'fulfilled'
          ? this.toCellMatrix(formulaResult.value.data.values)
          : undefined,
      );

      if (formulaResult.status === 'rejected') {
        shaped.warnings = [
          ...(shaped.warnings ?? []),
          this.buildFormulaFallbackWarning(
            formulaResult.reason,
            'read_workspace_spreadsheet_values',
            { spreadsheet_id: spreadsheetId, continuation_token: token },
          ),
        ];
      }

      return {
        success: true,
        data: shaped,
      };
    }

    const response = await client.spreadsheets.values.get({
      spreadsheetId,
      range: continuationRange,
      majorDimension: options.majorDimension || 'ROWS',
      valueRenderOption: this.resolveValueRenderOption(options.valueView),
    });

    if (options.returnJson) {
      return {
        success: true,
        data: response.data,
      };
    }

    return {
      success: true,
      data: {
        title: continuationRange,
        spreadsheetId,
        spreadsheetUrl: this.constructSpreadsheetUrl(spreadsheetId),
        values: this.toCellMatrix(response.data.values),
      } as SpreadsheetResponse,
    };
  }

  /**
   * Get spreadsheet metadata and optionally values
   */
  async getSpreadsheet(
    email: string,
    spreadsheetId: string,
    options: ReadSpreadsheetOptions = {}
  ): Promise<SheetsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      // Get spreadsheet metadata
      const metadataResponse = await client.spreadsheets.get({
        spreadsheetId,
        includeGridData: false,
      });

      const spreadsheet = metadataResponse.data;
      const sheets = spreadsheet.sheets?.map(s => this.extractSheetInfo(s)) || [];

      // If a range is specified, also get values
      let values: CellValue[][] | undefined;
      let shapedValues: ShapedReadResponse | undefined;
      let anchorValues: AnchorReadResponse | undefined;
      let truncated = false;

      if (options.range) {
        if (options.valueView === 'shaped') {
          const shapedResult = await this.getShapedValues(email, spreadsheetId, {
            range: options.range,
            majorDimension: 'ROWS',
            valueView: 'shaped',
            anchorMode: options.anchorMode,
            continuationToken: options.continuationToken,
            returnJson: options.returnJson,
          });

          if (!shapedResult.success || !shapedResult.data) {
            return {
              success: false,
              error: shapedResult.error ?? 'Failed to read spreadsheet values',
            };
          }

          if (this.isAnchorReadResponse(shapedResult.data)) {
            anchorValues = shapedResult.data;
          } else {
            shapedValues = shapedResult.data as ShapedReadResponse;
          }
        } else {
          const valuesResult = await this.getValues(email, spreadsheetId, {
            range: options.range,
            returnJson: true,
            valueView: options.valueView,
            anchorMode: options.anchorMode,
            continuationToken: options.continuationToken,
            internalCall: true,
          });

          if (valuesResult.success && valuesResult.data) {
            if (this.isAnchorReadResponse(valuesResult.data)) {
              anchorValues = valuesResult.data;
            } else {
              const valueRange = valuesResult.data as sheets_v4.Schema$ValueRange;
              values = this.toCellMatrix(valueRange.values);

              // Apply truncation if needed
              const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
              const maxCols = options.maxCols ?? DEFAULT_MAX_COLS;

              if (values && values.length > maxRows) {
                values = values.slice(0, maxRows);
                truncated = true;
              }
              if (values) {
                values = values.map(row => {
                  if (row.length > maxCols) {
                    truncated = true;
                    return row.slice(0, maxCols);
                  }
                  return row;
                });
              }
            }
          }
        }
      }

      const result: SpreadsheetResponse = {
        title: spreadsheet.properties?.title || 'Untitled',
        spreadsheetId: spreadsheet.spreadsheetId || spreadsheetId,
        spreadsheetUrl: this.constructSpreadsheetUrl(spreadsheet.spreadsheetId || spreadsheetId),
        sheets,
        values,
        truncated,
        shapedValues,
        anchorValues,
      };

      const preserveLegacySpreadsheetJsonShape =
        options.returnJson
        && options.valueView === undefined
        && options.anchorMode === undefined
        && options.continuationToken === undefined;

      return {
        success: true,
        data: preserveLegacySpreadsheetJsonShape ? spreadsheet : result,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Read values from a spreadsheet range
   */
  async getValues(
    email: string,
    spreadsheetId: string,
    options: ReadValuesOptions
  ): Promise<SheetsOperationResult> {
    try {
      if (options.continuationToken) {
        return this.getContinuationPage(email, spreadsheetId, options);
      }

      if (options.valueView === 'shaped') {
        return this.getShapedValues(email, spreadsheetId, options);
      }

      const shouldAnchor = this.shouldUseAnchor({
        anchorMode: options.anchorMode,
        continuationToken: options.continuationToken,
        range: options.range,
      });
      if (shouldAnchor && this.canUseAnchorEnvelope(options)) {
        return this.getAnchorRead(email, spreadsheetId, options);
      }

      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const valueRenderOption = this.resolveValueRenderOption(options.valueView);

      const response = await client.spreadsheets.values.get({
        spreadsheetId,
        range: options.range,
        majorDimension: options.majorDimension || 'ROWS',
        valueRenderOption,
      });

      if (options.returnJson) {
        return {
          success: true,
          data: response.data,
        };
      }

      // Format as SpreadsheetResponse for human-readable output
      const values = this.toCellMatrix(response.data.values);
      const result: SpreadsheetResponse = {
        title: options.range,
        spreadsheetId,
        spreadsheetUrl: this.constructSpreadsheetUrl(spreadsheetId),
        values,
      };

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      if (error instanceof ContinuationTokenError) {
        return {
          success: false,
          error: `${error.message} ${error.suggestion}`,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  async getShapedValues(
    email: string,
    spreadsheetId: string,
    options: ReadValuesOptions
  ): Promise<SheetsOperationResult> {
    try {
      if (options.continuationToken) {
        return this.getContinuationPage(email, spreadsheetId, { ...options, valueView: 'shaped' });
      }

      const shouldAnchor = this.shouldUseAnchor({
        anchorMode: options.anchorMode,
        continuationToken: options.continuationToken,
        range: options.range,
      });
      if (shouldAnchor && this.canUseAnchorEnvelope(options)) {
        return this.getAnchorRead(email, spreadsheetId, { ...options, valueView: 'shaped' });
      }

      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const [formattedResult, formulaResult] = await Promise.allSettled([
        client.spreadsheets.values.get({
          spreadsheetId,
          range: options.range,
          majorDimension: options.majorDimension || 'ROWS',
          valueRenderOption: 'FORMATTED_VALUE',
        }),
        client.spreadsheets.values.get({
          spreadsheetId,
          range: options.range,
          majorDimension: options.majorDimension || 'ROWS',
          valueRenderOption: 'FORMULA',
        }),
      ]);

      if (formattedResult.status === 'rejected') {
        throw formattedResult.reason;
      }

      const formattedValues = this.toCellMatrix(formattedResult.value.data.values);
      const range = formattedResult.value.data.range || options.range;
      let formulaValues: CellValue[][] | undefined;
      const fallbackWarnings: ShapedWarning[] = [];

      if (formulaResult.status === 'fulfilled') {
        formulaValues = this.toCellMatrix(formulaResult.value.data.values);
      } else {
        fallbackWarnings.push(
          this.buildFormulaFallbackWarning(
            formulaResult.reason,
            'read_workspace_spreadsheet_values',
            { spreadsheet_id: spreadsheetId, range: options.range },
          ),
        );
      }

      const shaped = buildShapedReadResponse(range, formattedValues, formulaValues);
      if (fallbackWarnings.length > 0) {
        shaped.warnings = [...(shaped.warnings ?? []), ...fallbackWarnings];
      }

      return {
        success: true,
        data: shaped,
      };
    } catch (error) {
      if (error instanceof ContinuationTokenError) {
        return {
          success: false,
          error: `${error.message} ${error.suggestion}`,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  private getFormulaSafetyAlternatives(): string[] {
    return [
      'Write to non-formula cells.',
      'Update formulas via Phase 2 set_formula tool when available.',
    ];
  }

  private toErrorMessage(error: unknown): string {
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private classifyFormulaPreReadError(error: unknown): 'permission' | 'transient' | 'unknown' {
    const message = this.toErrorMessage(error);
    if (/The caller does not have permission|insufficient permissions|insufficient authentication scopes|PERMISSION_DENIED|403/i.test(message)) {
      return 'permission';
    }

    if (/RATE_LIMIT_EXCEEDED|Quota exceeded|429|timeout|temporarily unavailable|backendError|internal error|503|500/i.test(message)) {
      return 'transient';
    }

    return 'unknown';
  }

  private buildFormulaSafetyUnverifiableMessage(
    kind: 'permission' | 'transient' | 'unknown',
    rewrittenError: string,
  ): string {
    const bestEffortLine =
      `Best-effort: protects against formula overwrite absent concurrent edits to the same range during the call. Sheets has no transactional write API; under concurrent edits the guard cannot guarantee zero overwrites.`;

    if (kind === 'permission') {
      return `Could not verify formula safety before write because formula metadata read permission failed (likely scope or sharing access). The write was not attempted. ${bestEffortLine} ${rewrittenError}`;
    }

    if (kind === 'transient') {
      return `Could not verify formula safety before write due to a transient Sheets API error (for example rate limiting). The write was not attempted. ${bestEffortLine} ${rewrittenError}`;
    }

    return `Could not verify formula safety before write. The write was not attempted. ${bestEffortLine} ${rewrittenError}`;
  }

  private buildFormulaOverwriteRefusalMessage(formulaCells: Array<{ a1: string; formula: string }>): string {
    const formattedCells = formulaCells
      .map((cell) => `${cell.a1} (${cell.formula})`)
      .join(', ');

    return `Refusing to overwrite formulas at ${formattedCells}. Re-run with overwrite_formulas: true to explicitly authorize this write, or write to non-formula cells. Best-effort: protects against formula overwrite absent concurrent edits to the same range during the call. Sheets has no transactional write API; under concurrent edits the guard cannot guarantee zero overwrites.`;
  }

  private makeFormulaRefusalResult(
    errorCode: FormulaSafetyErrorCode,
    error: string,
    formulaCells?: Array<{ a1: string; formula: string; proposedValue: unknown }>,
  ): SheetsOperationResult {
    return {
      success: false,
      error,
      errorCode,
      retryWith: { overwrite_formulas: true },
      alternatives: this.getFormulaSafetyAlternatives(),
      formulaCells,
    };
  }

  private async fetchExistingFormulas(
    email: string,
    spreadsheetId: string,
    range: string,
    tool: string,
    clientOverride?: sheets_v4.Sheets,
  ): Promise<FormulaPreReadResult> {
    try {
      const client = clientOverride ?? await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth }),
      );

      const parsed = parseA1Range(range);
      const response = await client.spreadsheets.get({
        spreadsheetId,
        ranges: [range],
        includeGridData: true,
        fields: 'sheets(properties(title,sheetId),data(startRow,startColumn,rowData(values(userEnteredValue))))',
      });

      const formulaCells: ExistingFormulaCell[] = [];
      for (const sheet of response.data.sheets ?? []) {
        const sheetTitle = sheet.properties?.title ?? parsed?.sheetName ?? 'Sheet1';
        for (const gridData of sheet.data ?? []) {
          const startRow = gridData.startRow ?? 0;
          const startColumn = gridData.startColumn ?? 0;
          const rows = gridData.rowData ?? [];
          for (let rowOffset = 0; rowOffset < rows.length; rowOffset += 1) {
            const rowValues = rows[rowOffset]?.values ?? [];
            for (let columnOffset = 0; columnOffset < rowValues.length; columnOffset += 1) {
              const formula = rowValues[columnOffset]?.userEnteredValue?.formulaValue;
              if (!formula) {
                continue;
              }

              formulaCells.push({
                sheetTitle,
                rowIndex: startRow + rowOffset,
                columnIndex: startColumn + columnOffset,
                formula,
              });
            }
          }
        }
      }

      return { formulaCells };
    } catch (error) {
      const kind = this.classifyFormulaPreReadError(error);
      const rewrittenError = rewriteSheetsApiError(error, {
        tool,
        input: {
          spreadsheet_id: spreadsheetId,
          range,
        },
      });

      return {
        formulaCells: [],
        error: this.buildFormulaSafetyUnverifiableMessage(kind, rewrittenError),
        errorKind: kind,
      };
    }
  }

  private async fetchSingleCellAboveRowsContext(
    client: sheets_v4.Sheets,
    spreadsheetId: string,
    targetRange: string,
  ): Promise<CellTriad[][] | undefined> {
    const parsed = parseA1Range(targetRange);
    if (!parsed?.startCol || !parsed.startRow || parsed.startRow <= 1) {
      return undefined;
    }

    const endRow = parsed.startRow - 1;
    const startRow = Math.max(1, endRow - 199);
    const sheetPrefix = parsed.sheetName ? `${quoteSheetNameIfNeeded(parsed.sheetName)}!` : '';
    const contextRange = `${sheetPrefix}${parsed.startCol}${startRow}:${parsed.startCol}${endRow}`;

    try {
      const response = await client.spreadsheets.values.get({
        spreadsheetId,
        range: contextRange,
        majorDimension: 'ROWS',
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
      const values = this.toCellMatrix(response.data.values) ?? [];
      return values.map((row) => [{ value: row[0] ?? null }]);
    } catch {
      return undefined;
    }
  }

  private formulaLooksLikeFillDown(formula: string, previousRow: number): boolean {
    if (previousRow <= 0) {
      return false;
    }
    const rowReferenceRegex = new RegExp(`\\$?[A-Z]{1,3}\\$?${previousRow}(?!\\d)`, 'i');
    return rowReferenceRegex.test(formula);
  }

  private toNumeric(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private buildAppendFillDownWarning(
    values: CellValue[][],
    sheetTitle: string,
    startColumnIndex: number,
    lastFormulaRowIndex: number,
    formulaByColumnOffset: Map<number, string>,
  ): SuspiciousWriteWarning[] {
    const warnings: SuspiciousWriteWarning[] = [];
    if (values.length === 0) {
      return warnings;
    }

    const appendedStartRow = lastFormulaRowIndex + 2;
    for (const [columnOffset, formula] of formulaByColumnOffset.entries()) {
      const proposedColumnValues = values
        .map((row) => row[columnOffset])
        .map((value) => this.toNumeric(value))
        .filter((value): value is number => value !== null);
      if (proposedColumnValues.length === 0) {
        continue;
      }

      const columnIndex = startColumnIndex + columnOffset;
      const columnLetter = this.columnIndexToLetter(columnIndex + 1);
      const endRow = appendedStartRow + values.length - 1;

      warnings.push({
        kind: 'looks_like_fill_down',
        column: columnLetter,
        rows: Array.from({ length: values.length }, (_, index) => appendedStartRow + index),
        suggestedFormula: formula,
        detail: `Possible formula opportunity: column ${columnLetter} appears to use a fill-down formula in ${quoteSheetNameIfNeeded(sheetTitle)}!${columnLetter}${lastFormulaRowIndex + 1}. New row(s) ${appendedStartRow}-${endRow} will break the pattern. Consider extending the formula range or copying the formula.`,
      });
    }

    return warnings;
  }

  private async detectAppendFillDownWarnings(
    client: sheets_v4.Sheets,
    spreadsheetId: string,
    range: string,
    values: CellValue[][],
  ): Promise<SuspiciousWriteWarning[]> {
    const parsed = parseA1Range(range);
    const metadata = await client.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(title,sheetId,gridProperties(rowCount,columnCount)))',
    });

    const sheets = metadata.data.sheets ?? [];
    const targetSheet = parsed?.sheetName
      ? sheets.find((sheet) => sheet.properties?.title === parsed.sheetName)
      : sheets[0];

    if (!targetSheet?.properties?.title) {
      return [];
    }

    const rowCount = targetSheet.properties.gridProperties?.rowCount ?? 0;
    if (rowCount <= 1) {
      return [];
    }

    const startColIndex = parsed?.startCol
      ? Math.max(1, this.columnLetterToIndex(parsed.startCol)) - 1
      : 0;
    const proposedWidth = Math.max(1, ...values.map((row) => row.length), 1);
    const defaultEndColIndex = startColIndex + proposedWidth - 1;
    const endColIndex = parsed?.endCol
      ? Math.max(startColIndex, this.columnLetterToIndex(parsed.endCol) - 1)
      : defaultEndColIndex;
    const startColLetter = this.columnIndexToLetter(startColIndex + 1);
    const endColLetter = this.columnIndexToLetter(endColIndex + 1);

    const readStartRow = Math.max(1, rowCount - 4);
    const sheetName = quoteSheetNameIfNeeded(targetSheet.properties.title);
    const formulaReadRange = `${sheetName}!${startColLetter}${readStartRow}:${endColLetter}${rowCount}`;
    const formulaRead = await client.spreadsheets.get({
      spreadsheetId,
      ranges: [formulaReadRange],
      includeGridData: true,
      fields: 'sheets(properties(title),data(startRow,startColumn,rowData(values(userEnteredValue))))',
    });

    let latestFormulaRowIndex = -1;
    const formulasByColumnOffset = new Map<number, string>();

    for (const sheet of formulaRead.data.sheets ?? []) {
      for (const gridData of sheet.data ?? []) {
        const startRow = gridData.startRow ?? 0;
        const startColumn = gridData.startColumn ?? 0;
        for (let rowOffset = 0; rowOffset < (gridData.rowData ?? []).length; rowOffset += 1) {
          const rowIndex = startRow + rowOffset;
          const valuesAtRow = gridData.rowData?.[rowOffset]?.values ?? [];

          const rowFormulas = new Map<number, string>();
          for (let columnOffset = 0; columnOffset < valuesAtRow.length; columnOffset += 1) {
            const formula = valuesAtRow[columnOffset]?.userEnteredValue?.formulaValue;
            if (!formula || !this.formulaLooksLikeFillDown(formula, rowIndex)) {
              continue;
            }

            const absoluteColumn = startColumn + columnOffset;
            rowFormulas.set(absoluteColumn - startColIndex, formula);
          }

          if (rowFormulas.size > 0 && rowIndex >= latestFormulaRowIndex) {
            latestFormulaRowIndex = rowIndex;
            formulasByColumnOffset.clear();
            for (const [offset, formula] of rowFormulas.entries()) {
              formulasByColumnOffset.set(offset, formula);
            }
          }
        }
      }
    }

    if (latestFormulaRowIndex < 0 || formulasByColumnOffset.size === 0) {
      return [];
    }

    return this.buildAppendFillDownWarning(
      values,
      targetSheet.properties.title,
      startColIndex,
      latestFormulaRowIndex,
      formulasByColumnOffset,
    );
  }

  /**
   * Create a new spreadsheet
   */
  async createSpreadsheet(
    email: string,
    options: CreateSpreadsheetOptions
  ): Promise<SheetsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      // Build sheets array if sheet titles provided
      const sheets: sheets_v4.Schema$Sheet[] | undefined = options.sheetTitles?.map((title, index) => ({
        properties: {
          title,
          index,
        },
      }));

      const response = await client.spreadsheets.create({
        requestBody: {
          properties: {
            title: options.title,
          },
          sheets: sheets || undefined,
        },
      });

      const spreadsheet = response.data;
      if (!spreadsheet.spreadsheetId) {
        return {
          success: false,
          error: 'Failed to create spreadsheet - no spreadsheetId returned',
        };
      }

      const result: SpreadsheetResponse = {
        title: options.title,
        spreadsheetId: spreadsheet.spreadsheetId,
        spreadsheetUrl: this.constructSpreadsheetUrl(spreadsheet.spreadsheetId),
        sheets: spreadsheet.sheets?.map(s => this.extractSheetInfo(s)),
      };

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Append values to a spreadsheet (adds rows after existing data)
   */
  async appendValues(
    email: string,
    options: AppendValuesOptions
  ): Promise<SheetsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const valueInputOption = options.valueInputOption || 'USER_ENTERED';
      const warnings: SuspiciousWriteWarning[] = [];

      if (!options.overwriteFormulas) {
        try {
          const appendWarnings = await this.detectAppendFillDownWarnings(
            client,
            options.spreadsheetId,
            options.range,
            options.values,
          );
          warnings.push(...appendWarnings);
        } catch (error) {
          logger.warn(
            `append_to_workspace_spreadsheet: fill-down pre-read failed; proceeding without append warning. ${this.toErrorMessage(error)}`,
          );
        }
      }

      warnings.push(
        ...detectSuspiciousWrites({
          targetRange: options.range,
          proposedValues: options.values,
        }),
      );
      warnings.push(
        ...detectRawFormulaLiterals(options.range, options.values, valueInputOption),
      );

      const response = await client.spreadsheets.values.append({
        spreadsheetId: options.spreadsheetId,
        range: options.range,
        valueInputOption,
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: options.values,
        },
      });

      const updates = response.data.updates;
      const writeResponse: WriteResponse = {
        title: options.range,
        spreadsheetId: options.spreadsheetId,
        spreadsheetUrl: this.constructSpreadsheetUrl(options.spreadsheetId),
        warnings: warnings.length > 0 ? warnings : undefined,
      };

      return {
        success: true,
        data: writeResponse,
        updatedCells: updates?.updatedCells ?? undefined,
        updatedRows: updates?.updatedRows ?? undefined,
        updatedColumns: updates?.updatedColumns ?? undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Update values in a specific range
   */
  async updateValues(
    email: string,
    options: UpdateValuesOptions
  ): Promise<SheetsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const valueInputOption = options.valueInputOption || 'USER_ENTERED';

      if (!options.overwriteFormulas) {
        const preReadResult = await this.fetchExistingFormulas(
          email,
          options.spreadsheetId,
          options.range,
          'update_workspace_spreadsheet_values',
          client,
        );

        if (preReadResult.error) {
          return this.makeFormulaRefusalResult(
            'formula_safety_unverifiable',
            preReadResult.error,
          );
        }

        const overwrites = detectFormulaOverwrite(
          options.range,
          options.values,
          preReadResult.formulaCells,
        );

        if (overwrites.length > 0) {
          return this.makeFormulaRefusalResult(
            'formula_overwrite_refused',
            this.buildFormulaOverwriteRefusalMessage(overwrites),
            overwrites,
          );
        }
      }

      const isSingleCellWrite = options.values.length === 1 && (options.values[0]?.length ?? 0) === 1;
      const aboveRows = isSingleCellWrite
        ? await this.fetchSingleCellAboveRowsContext(client, options.spreadsheetId, options.range)
        : undefined;
      const warnings: SuspiciousWriteWarning[] = [
        ...detectSuspiciousWrites({
          targetRange: options.range,
          proposedValues: options.values,
          adjacentContext: aboveRows ? { aboveRows } : undefined,
        }),
        ...detectRawFormulaLiterals(options.range, options.values, valueInputOption),
      ];

      const response = await client.spreadsheets.values.update({
        spreadsheetId: options.spreadsheetId,
        range: options.range,
        valueInputOption,
        requestBody: {
          values: options.values,
        },
      });

      const writeResponse: WriteResponse = {
        title: options.range,
        spreadsheetId: options.spreadsheetId,
        spreadsheetUrl: this.constructSpreadsheetUrl(options.spreadsheetId),
        warnings: warnings.length > 0 ? warnings : undefined,
      };

      return {
        success: true,
        data: writeResponse,
        updatedCells: response.data.updatedCells ?? undefined,
        updatedRows: response.data.updatedRows ?? undefined,
        updatedColumns: response.data.updatedColumns ?? undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Clear values in a range
   */
  async clearValues(
    email: string,
    options: ClearValuesOptions
  ): Promise<SheetsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const response = await client.spreadsheets.values.clear({
        spreadsheetId: options.spreadsheetId,
        range: options.range,
      });

      return {
        success: true,
        data: {
          title: options.range,
          spreadsheetId: options.spreadsheetId,
          spreadsheetUrl: this.constructSpreadsheetUrl(options.spreadsheetId),
        },
        clearedRange: response.data.clearedRange ?? undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Add a new sheet to an existing spreadsheet
   */
  async addSheet(
    email: string,
    options: AddSheetOptions
  ): Promise<SheetsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const response = await client.spreadsheets.batchUpdate({
        spreadsheetId: options.spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: options.title,
                  gridProperties: {
                    rowCount: options.rowCount || 1000,
                    columnCount: options.columnCount || 26,
                  },
                },
              },
            },
          ],
        },
      });

      const addedSheet = response.data.replies?.[0]?.addSheet;
      if (!addedSheet?.properties) {
        return {
          success: false,
          error: 'Failed to add sheet - no sheet properties returned',
        };
      }

      const sheetInfo: SheetInfo = {
        sheetId: addedSheet.properties.sheetId ?? 0,
        title: addedSheet.properties.title || options.title,
        index: addedSheet.properties.index ?? 0,
        rowCount: addedSheet.properties.gridProperties?.rowCount ?? undefined,
        columnCount: addedSheet.properties.gridProperties?.columnCount ?? undefined,
      };

      return {
        success: true,
        data: sheetInfo,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Delete a sheet from a spreadsheet
   */
  async deleteSheet(
    email: string,
    options: DeleteSheetOptions
  ): Promise<SheetsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      await client.spreadsheets.batchUpdate({
        spreadsheetId: options.spreadsheetId,
        requestBody: {
          requests: [
            {
              deleteSheet: {
                sheetId: options.sheetId,
              },
            },
          ],
        },
      });

      return {
        success: true,
        data: {
          title: `Sheet ${options.sheetId} deleted`,
          spreadsheetId: options.spreadsheetId,
          spreadsheetUrl: this.constructSpreadsheetUrl(options.spreadsheetId),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * List all sheets in a spreadsheet
   */
  async listSheets(
    email: string,
    options: ListSheetsOptions
  ): Promise<SheetsOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const response = await client.spreadsheets.get({
        spreadsheetId: options.spreadsheetId,
        fields: 'spreadsheetId,properties.title,sheets.properties',
      });

      const spreadsheet = response.data;
      const sheets = spreadsheet.sheets?.map(s => this.extractSheetInfo(s)) || [];

      const result: SpreadsheetResponse = {
        title: spreadsheet.properties?.title || 'Untitled',
        spreadsheetId: spreadsheet.spreadsheetId || options.spreadsheetId,
        spreadsheetUrl: this.constructSpreadsheetUrl(spreadsheet.spreadsheetId || options.spreadsheetId),
        sheets,
      };

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Batch read values from multiple ranges in a single API call
   */
  async batchGetValues(
    email: string,
    options: BatchGetValuesOptions
  ): Promise<BatchOperationResult> {
    try {
      if (options.valueView === 'shaped') {
        return this.batchGetShapedValues(email, options);
      }

      const anchorEligible = this.canUseAnchorEnvelope({
        returnJson: options.returnJson,
        anchorMode: options.anchorMode,
      });
      const shouldAnchorAnyRange = anchorEligible && options.ranges.some((range) =>
        this.shouldUseAnchor({
          anchorMode: options.anchorMode,
          range,
        }),
      );
      if (shouldAnchorAnyRange) {
        const perRangeResults: Array<BatchValuesResult | BatchAnchorValuesResult> = [];
        for (const range of options.ranges) {
          const shouldAnchor = this.shouldUseAnchor({
            anchorMode: options.anchorMode,
            range,
          });

          if (shouldAnchor) {
            const anchorResult = await this.getAnchorRead(email, options.spreadsheetId, {
              range,
              majorDimension: options.majorDimension,
              returnJson: options.returnJson,
              valueView: options.valueView,
              anchorMode: options.anchorMode,
            });

            if (!anchorResult.success || !anchorResult.data || !this.isAnchorReadResponse(anchorResult.data)) {
              return {
                success: false,
                error: anchorResult.error ?? `Failed to anchor-read range '${range}'`,
              };
            }

            perRangeResults.push({
              range,
              anchor: anchorResult.data,
            });
            continue;
          }

          const singleRangeResult = await this.getValues(email, options.spreadsheetId, {
            range,
            majorDimension: options.majorDimension,
            returnJson: true,
            valueView: options.valueView,
            anchorMode: 'never',
          });
          if (!singleRangeResult.success || !singleRangeResult.data) {
            return {
              success: false,
              error: singleRangeResult.error ?? `Failed to read range '${range}'`,
            };
          }

          const valueRange = singleRangeResult.data as sheets_v4.Schema$ValueRange;
          perRangeResults.push({
            range: valueRange.range || range,
            values: this.toCellMatrix(valueRange.values) ?? [],
          });
        }

        return {
          success: true,
          data: perRangeResults,
        };
      }

      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const valueRenderOption = this.resolveValueRenderOption(options.valueView);

      const response = await client.spreadsheets.values.batchGet({
        spreadsheetId: options.spreadsheetId,
        ranges: options.ranges,
        majorDimension: options.majorDimension || 'ROWS',
        valueRenderOption,
      });

      const valueRanges = response.data.valueRanges ?? [];
      const results: BatchValuesResult[] = valueRanges.map(vr => ({
        range: vr.range || '',
        values: this.toCellMatrix(vr.values) ?? [],
      }));

      return {
        success: true,
        data: results,
      };
    } catch (error) {
      if (error instanceof ContinuationTokenError) {
        return {
          success: false,
          error: `${error.message} ${error.suggestion}`,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  async batchGetShapedValues(
    email: string,
    options: BatchGetValuesOptions
  ): Promise<BatchOperationResult> {
    try {
      const anchorEligible = this.canUseAnchorEnvelope({
        returnJson: options.returnJson,
        anchorMode: options.anchorMode,
      });
      const shouldAnchorAnyRange = anchorEligible && options.ranges.some((range) =>
        this.shouldUseAnchor({
          anchorMode: options.anchorMode,
          range,
        }),
      );
      if (shouldAnchorAnyRange) {
        const perRangeResults: Array<BatchShapedValuesResult | BatchAnchorValuesResult> = [];
        for (const range of options.ranges) {
          const shapedResult = await this.getShapedValues(email, options.spreadsheetId, {
            range,
            majorDimension: options.majorDimension,
            returnJson: options.returnJson,
            valueView: 'shaped',
            anchorMode: options.anchorMode,
          });

          if (!shapedResult.success || !shapedResult.data) {
            return {
              success: false,
              error: shapedResult.error ?? `Failed to read shaped range '${range}'`,
            };
          }

          if (this.isAnchorReadResponse(shapedResult.data)) {
            perRangeResults.push({
              range,
              anchor: shapedResult.data,
            });
          } else {
            perRangeResults.push({
              range,
              shaped: shapedResult.data as ShapedReadResponse,
            });
          }
        }

        return {
          success: true,
          data: perRangeResults,
        };
      }

      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const [formattedResult, formulaResult] = await Promise.allSettled([
        client.spreadsheets.values.batchGet({
          spreadsheetId: options.spreadsheetId,
          ranges: options.ranges,
          majorDimension: options.majorDimension || 'ROWS',
          valueRenderOption: 'FORMATTED_VALUE',
        }),
        client.spreadsheets.values.batchGet({
          spreadsheetId: options.spreadsheetId,
          ranges: options.ranges,
          majorDimension: options.majorDimension || 'ROWS',
          valueRenderOption: 'FORMULA',
        }),
      ]);

      if (formattedResult.status === 'rejected') {
        throw formattedResult.reason;
      }

      const formattedRanges = formattedResult.value.data.valueRanges ?? [];
      const formulaRanges = formulaResult.status === 'fulfilled'
        ? formulaResult.value.data.valueRanges ?? []
        : undefined;
      const formulaRangesByRange = new Map((formulaRanges ?? []).map((range) => [range.range ?? '', range]));
      const fallbackWarning = formulaResult.status === 'fulfilled'
        ? undefined
        : this.buildFormulaFallbackWarning(
            formulaResult.reason,
            'batch_read_workspace_spreadsheet_values',
            { spreadsheet_id: options.spreadsheetId, ranges: options.ranges },
          );

      const results: BatchShapedValuesResult[] = options.ranges.map((requestedRange, index) => {
        const formattedRange = formattedRanges[index];
        const resolvedFormattedRange = formattedRange?.range || requestedRange;
        const formulaRange = formulaRanges?.[index]
          ?? formulaRangesByRange.get(resolvedFormattedRange)
          ?? formulaRangesByRange.get(requestedRange);

        const shaped = buildShapedReadResponse(
          resolvedFormattedRange,
          this.toCellMatrix(formattedRange?.values),
          this.toCellMatrix(formulaRange?.values),
        );

        if (fallbackWarning) {
          shaped.warnings = [...(shaped.warnings ?? []), fallbackWarning];
        }

        return {
          range: resolvedFormattedRange,
          shaped,
        };
      });

      return {
        success: true,
        data: results,
      };
    } catch (error) {
      if (error instanceof ContinuationTokenError) {
        return {
          success: false,
          error: `${error.message} ${error.suggestion}`,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Batch update values in multiple ranges in a single API call
   */
  async batchUpdateValues(
    email: string,
    options: BatchUpdateValuesOptions
  ): Promise<BatchOperationResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const valueInputOption = options.valueInputOption || 'USER_ENTERED';

      if (!options.overwriteFormulas) {
        const allOverwrites: Array<{ a1: string; formula: string; proposedValue: unknown }> = [];

        for (const entry of options.data) {
          const preReadResult = await this.fetchExistingFormulas(
            email,
            options.spreadsheetId,
            entry.range,
            'batch_update_workspace_spreadsheet_values',
            client,
          );

          if (preReadResult.error) {
            return {
              success: false,
              error: preReadResult.error,
              errorCode: 'formula_safety_unverifiable',
              retryWith: { overwrite_formulas: true },
              alternatives: this.getFormulaSafetyAlternatives(),
            };
          }

          const overwrites = detectFormulaOverwrite(
            entry.range,
            entry.values,
            preReadResult.formulaCells,
          );
          allOverwrites.push(...overwrites);
        }

        if (allOverwrites.length > 0) {
          return {
            success: false,
            error: this.buildFormulaOverwriteRefusalMessage(allOverwrites),
            errorCode: 'formula_overwrite_refused',
            retryWith: { overwrite_formulas: true },
            alternatives: this.getFormulaSafetyAlternatives(),
            formulaCells: allOverwrites,
          };
        }
      }

      const warnings: SuspiciousWriteWarning[] = [];
      for (const entry of options.data) {
        const isSingleCellWrite = entry.values.length === 1 && (entry.values[0]?.length ?? 0) === 1;
        const aboveRows = isSingleCellWrite
          ? await this.fetchSingleCellAboveRowsContext(client, options.spreadsheetId, entry.range)
          : undefined;

        warnings.push(
          ...detectSuspiciousWrites({
            targetRange: entry.range,
            proposedValues: entry.values,
            adjacentContext: aboveRows ? { aboveRows } : undefined,
          }),
        );
        warnings.push(
          ...detectRawFormulaLiterals(entry.range, entry.values, valueInputOption),
        );
      }

      const response = await client.spreadsheets.values.batchUpdate({
        spreadsheetId: options.spreadsheetId,
        requestBody: {
          valueInputOption,
          data: options.data.map(d => ({
            range: d.range,
            values: d.values,
          })),
        },
      });

      return {
        success: true,
        warnings: warnings.length > 0 ? warnings : undefined,
        totalUpdatedCells: response.data.totalUpdatedCells ?? undefined,
        totalUpdatedRows: response.data.totalUpdatedRows ?? undefined,
        totalUpdatedSheets: response.data.totalUpdatedSheets ?? undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Find and replace text throughout a spreadsheet or specific sheet
   */
  async findAndReplace(
    email: string,
    options: FindReplaceOptions
  ): Promise<FindReplaceResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const findReplaceRequest: sheets_v4.Schema$FindReplaceRequest = {
        find: options.find,
        replacement: options.replacement,
        matchCase: options.matchCase ?? false,
        matchEntireCell: options.matchEntireCell ?? false,
        searchByRegex: options.searchByRegex ?? false,
        includeFormulas: options.includeFormulas ?? false,
      };

      // Scope: specific sheet or all sheets
      if (options.sheetId !== undefined) {
        findReplaceRequest.sheetId = options.sheetId;
      } else {
        findReplaceRequest.allSheets = true;
      }

      const response = await client.spreadsheets.batchUpdate({
        spreadsheetId: options.spreadsheetId,
        requestBody: {
          requests: [{ findReplace: findReplaceRequest }],
        },
      });

      const replies = response.data.replies ?? [];
      const fr = replies[0]?.findReplace;

      return {
        success: true,
        occurrencesChanged: fr?.occurrencesChanged ?? 0,
        valuesChanged: fr?.valuesChanged ?? 0,
        rowsChanged: fr?.rowsChanged ?? 0,
        sheetsChanged: fr?.sheetsChanged ?? 0,
        formulasChanged: fr?.formulasChanged ?? 0,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Format cells (bold, colors, borders)
   */
  async formatCells(
    email: string,
    options: FormatCellsOptions
  ): Promise<FormatResult> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [SHEETS_SCOPES.FULL]);

      const client = await this.getAuthenticatedClient(email, (auth) =>
        google.sheets({ version: 'v4', auth })
      );

      const range: sheets_v4.Schema$GridRange = {
        sheetId: options.sheetId,
        startRowIndex: options.startRowIndex,
        endRowIndex: options.endRowIndex,
        startColumnIndex: options.startColumnIndex,
        endColumnIndex: options.endColumnIndex,
      };

      const requests: sheets_v4.Schema$Request[] = [];
      const fields: string[] = [];

      // Build cell format
      const cellFormat: sheets_v4.Schema$CellFormat = {};
      const textFormat: sheets_v4.Schema$TextFormat = {};

      // Text formatting options
      if (options.bold !== undefined) {
        textFormat.bold = options.bold;
        fields.push('userEnteredFormat.textFormat.bold');
      }
      if (options.italic !== undefined) {
        textFormat.italic = options.italic;
        fields.push('userEnteredFormat.textFormat.italic');
      }
      if (options.underline !== undefined) {
        textFormat.underline = options.underline;
        fields.push('userEnteredFormat.textFormat.underline');
      }
      if (options.strikethrough !== undefined) {
        textFormat.strikethrough = options.strikethrough;
        fields.push('userEnteredFormat.textFormat.strikethrough');
      }
      if (options.fontSize !== undefined) {
        textFormat.fontSize = options.fontSize;
        fields.push('userEnteredFormat.textFormat.fontSize');
      }
      if (options.textColor) {
        textFormat.foregroundColor = {
          red: options.textColor.red ?? 0,
          green: options.textColor.green ?? 0,
          blue: options.textColor.blue ?? 0,
        };
        fields.push('userEnteredFormat.textFormat.foregroundColor');
      }

      if (Object.keys(textFormat).length > 0) {
        cellFormat.textFormat = textFormat;
      }

      // Background color
      if (options.backgroundColor) {
        cellFormat.backgroundColor = {
          red: options.backgroundColor.red ?? 1,
          green: options.backgroundColor.green ?? 1,
          blue: options.backgroundColor.blue ?? 1,
        };
        fields.push('userEnteredFormat.backgroundColor');
      }

      // Add repeatCell request if we have any formatting
      if (fields.length > 0) {
        requests.push({
          repeatCell: {
            range,
            cell: {
              userEnteredFormat: cellFormat,
            },
            fields: fields.join(','),
          },
        });
      }

      // Add borders if specified
      if (options.borderStyle || options.borderColor) {
        const border: sheets_v4.Schema$Border = {
          style: options.borderStyle || 'SOLID',
          color: options.borderColor
            ? {
                red: options.borderColor.red ?? 0,
                green: options.borderColor.green ?? 0,
                blue: options.borderColor.blue ?? 0,
              }
            : { red: 0, green: 0, blue: 0 },
        };

        requests.push({
          updateBorders: {
            range,
            top: border,
            bottom: border,
            left: border,
            right: border,
            innerHorizontal: border,
            innerVertical: border,
          },
        });
      }

      if (requests.length === 0) {
        return {
          success: false,
          error: 'No formatting options specified',
        };
      }

      await client.spreadsheets.batchUpdate({
        spreadsheetId: options.spreadsheetId,
        requestBody: { requests },
      });

      return {
        success: true,
        spreadsheetId: options.spreadsheetId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }
}
