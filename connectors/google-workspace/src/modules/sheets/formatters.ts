/**
 * Utilities for formatting Google Sheets content and parsing URLs.
 */

import type {
  AnchorReadResponse,
  CellTriad,
  SheetInfo,
  ShapedReadResponse,
  SpreadsheetResponse,
  SuspiciousWriteWarning,
} from './types.js';

/**
 * Construct a Google Sheets URL from spreadsheet ID
 */
export function constructSpreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

/**
 * Extract spreadsheet ID from various Google Sheets URL formats.
 * Supports:
 * - https://docs.google.com/spreadsheets/d/{id}/edit
 * - https://docs.google.com/spreadsheets/d/{id}/edit#gid=0
 * - https://docs.google.com/spreadsheets/d/{id}
 * - sheets.google.com/spreadsheets/d/{id}/...
 * - Just the spreadsheet ID itself
 */
export function extractSpreadsheetIdFromUrl(input: string): string | null {
  if (!input || typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim();

  // If it looks like just an ID (alphanumeric with hyphens/underscores, ~44 chars)
  if (/^[a-zA-Z0-9_-]{20,60}$/.test(trimmed)) {
    return trimmed;
  }

  // Try to extract from URL patterns
  const patterns = [
    // Standard Google Sheets URL
    /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    // Alternative domain
    /sheets\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    // URL-encoded
    /docs\.google\.com%2Fspreadsheets%2Fd%2F([a-zA-Z0-9_-]+)/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Format spreadsheet metadata as human-readable header
 */
export function formatSpreadsheetHeader(
  title: string,
  spreadsheetId: string,
  options?: {
    truncated?: boolean;
    sheetCount?: number;
    range?: string;
  }
): string {
  const lines: string[] = [
    `Spreadsheet: ${title}`,
    `URL: ${constructSpreadsheetUrl(spreadsheetId)}`,
    `ID: ${spreadsheetId}`,
  ];

  if (options?.range) {
    lines.push(`Range: ${options.range}`);
  }

  if (options?.sheetCount !== undefined) {
    lines.push(`Sheets: ${options.sheetCount}`);
  }

  if (options?.truncated) {
    lines.push('Status: TRUNCATED (data exceeded row/column limit)');
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Format 2D array of values as a text table
 */
export function formatValuesAsTable(
  values: (string | number | boolean | null)[][] | undefined,
  options?: {
    maxColWidth?: number;
    includeRowNumbers?: boolean;
  }
): string {
  if (!values || values.length === 0) {
    return '(empty)';
  }

  const maxColWidth = options?.maxColWidth ?? 30;
  const includeRowNumbers = options?.includeRowNumbers ?? true;

  // Find the maximum width for each column
  const colWidths: number[] = [];
  const numCols = Math.max(...values.map(row => row.length));

  for (let col = 0; col < numCols; col++) {
    let maxWidth = 0;
    for (const row of values) {
      const cellValue = row[col];
      const cellStr = cellValue !== null && cellValue !== undefined ? String(cellValue) : '';
      maxWidth = Math.max(maxWidth, Math.min(cellStr.length, maxColWidth));
    }
    colWidths.push(maxWidth || 1);
  }

  // Calculate row number width
  const rowNumWidth = includeRowNumbers ? String(values.length).length + 1 : 0;

  // Build the table
  const lines: string[] = [];

  for (let rowIdx = 0; rowIdx < values.length; rowIdx++) {
    const row = values[rowIdx];
    const cells: string[] = [];

    if (includeRowNumbers) {
      cells.push(String(rowIdx + 1).padStart(rowNumWidth - 1) + '|');
    }

    for (let col = 0; col < numCols; col++) {
      const cellValue = row[col];
      let cellStr = cellValue !== null && cellValue !== undefined ? String(cellValue) : '';

      // Truncate if too long
      if (cellStr.length > maxColWidth) {
        cellStr = cellStr.substring(0, maxColWidth - 3) + '...';
      }

      // Pad to column width
      cells.push(cellStr.padEnd(colWidths[col]));
    }

    lines.push(cells.join(' | '));
  }

  return lines.join('\n');
}

function formatShapedCell(cell: CellTriad): string | number | boolean | null {
  if (cell.formula) {
    if (cell.value !== null && cell.value !== undefined && String(cell.value).trim().length > 0) {
      return `${cell.formula} → ${cell.value}`;
    }
    return cell.formula;
  }
  return cell.value;
}

function formatAnchorRows(rows: CellTriad[][], startRow: number): string {
  const tableRows = rows.map((row, index) => [
    startRow + index,
    ...row.map((cell) => formatShapedCell(cell)),
  ]);

  return formatValuesAsTable(tableRows, { includeRowNumbers: false });
}

export function formatShapedReadResponse(response: ShapedReadResponse): string {
  const lines: string[] = [
    `Range: ${response.range}`,
    `Rows: ${response.rowCount}, Columns: ${response.columnCount}`,
    `Formula cells: ${response.formulaCellCount}`,
  ];

  if (response.inferredHeaders && response.inferredHeaders.length > 0 && response.inferredHeaderConfidence) {
    lines.push(
      `Inferred headers (${response.inferredHeaderConfidence} confidence): ${response.inferredHeaders.join(' | ')}`,
    );
  }

  if (response.columnTypes && response.columnTypes.length > 0) {
    lines.push(`Column types: ${response.columnTypes.join(' | ')}`);
  }

  lines.push('---');

  const tableRows = response.cells.map((row) => row.map((cell) => formatShapedCell(cell)));
  lines.push(formatValuesAsTable(tableRows));

  if (response.warnings && response.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of response.warnings) {
      lines.push(`  - ${warning.kind}: ${warning.message}`);
    }
  }

  return lines.join('\n');
}

export function formatAnchorReadResponse(response: AnchorReadResponse): string {
  const lines: string[] = [
    `Range: ${response.range}`,
    `Total rows: ${response.rowCount}  |  Columns: ${response.columnCount}`,
    '[ANCHOR ENVELOPE — partial data only]',
    '',
    `First ${response.firstRows.length} rows:`,
    formatAnchorRows(response.firstRows, response.firstRowsStartRow),
  ];

  if (response.lastRows && response.lastRows.length > 0 && response.lastRowsStartRow !== undefined) {
    lines.push('');
    lines.push(`Last ${response.lastRows.length} rows:`);
    lines.push(formatAnchorRows(response.lastRows, response.lastRowsStartRow));
  }

  if (response.columnSummary.length > 0) {
    lines.push('');
    lines.push('Column summary:');
    for (const column of response.columnSummary) {
      const headerLabel = column.headerSample ? ` (${column.headerSample})` : '';
      lines.push(
        `  ${column.column}${headerLabel}: ${column.nonEmptyCount}/${response.rowCount} non-empty, type: ${column.inferredType}`,
      );
    }
  }

  if (response.nextEmptyRow !== undefined) {
    lines.push('');
    lines.push(`Next empty row: ${response.nextEmptyRow}`);
  }

  if (response.omittedRowsSummary) {
    lines.push(response.omittedRowsSummary);
  }

  if (response.continuationToken) {
    const displayToken = response.continuationToken.length > 32
      ? `${response.continuationToken.slice(0, 32)}...`
      : response.continuationToken;
    lines.push('Use continuation_token to read omitted rows if needed.');
    lines.push('');
    lines.push(`continuationToken: ${displayToken} (truncated for display; copy from JSON form if needed)`);
  }

  if (response.warnings && response.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of response.warnings) {
      lines.push(`  - ${warning.kind}: ${warning.message}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format sheet info list as text
 */
export function formatSheetsListAsText(sheets: SheetInfo[]): string {
  if (!sheets || sheets.length === 0) {
    return 'No sheets found.';
  }

  const lines: string[] = [];
  lines.push(`Sheets: ${sheets.length}\n`);

  for (const sheet of sheets) {
    let line = `${sheet.index + 1}. ${sheet.title}`;
    if (sheet.rowCount !== undefined && sheet.columnCount !== undefined) {
      line += ` (${sheet.rowCount} rows x ${sheet.columnCount} cols)`;
    }
    line += ` [sheetId: ${sheet.sheetId}]`;
    lines.push(line);
  }

  return lines.join('\n');
}

/**
 * Format a complete spreadsheet response as human-readable text
 */
export function formatSpreadsheetAsText(response: SpreadsheetResponse): string {
  const header = formatSpreadsheetHeader(response.title, response.spreadsheetId, {
    truncated: response.truncated,
    sheetCount: response.sheets?.length,
  });

  const parts: string[] = [header];

  // Add sheets list if present
  if (response.sheets && response.sheets.length > 0) {
    parts.push(formatSheetsListAsText(response.sheets));
  }

  // Add values table if present
  if (response.values && response.values.length > 0) {
    if (response.sheets) {
      parts.push(''); // Add blank line separator
      parts.push('Data:');
    }
    parts.push(formatValuesAsTable(response.values));
  }

  return parts.join('\n');
}

/**
 * Format an operation result message
 */
export function formatOperationResult(
  operation: string,
  spreadsheetId: string,
  details?: {
    updatedCells?: number;
    updatedRows?: number;
    clearedRange?: string;
    sheetTitle?: string;
    warnings?: SuspiciousWriteWarning[];
  }
): string {
  const lines: string[] = [
    `${operation} completed successfully!`,
    '',
    `URL: ${constructSpreadsheetUrl(spreadsheetId)}`,
  ];

  if (details?.updatedCells !== undefined) {
    lines.push(`Updated cells: ${details.updatedCells}`);
  }
  if (details?.updatedRows !== undefined) {
    lines.push(`Updated rows: ${details.updatedRows}`);
  }
  if (details?.clearedRange) {
    lines.push(`Cleared range: ${details.clearedRange}`);
  }
  if (details?.sheetTitle) {
    lines.push(`Sheet: ${details.sheetTitle}`);
  }
  if (details?.warnings && details.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of details.warnings) {
      lines.push(`- ${warning.detail}`);
    }
  }

  return lines.join('\n');
}
