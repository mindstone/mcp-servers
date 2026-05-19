export interface SheetsApiErrorContext {
  tool: string;
  input: Record<string, unknown>;
}

function toErrorMessage(rawError: string | Error | unknown): string {
  if (typeof rawError === 'string') {
    return rawError;
  }

  if (rawError instanceof Error) {
    return rawError.message || rawError.toString();
  }

  if (typeof rawError === 'object' && rawError !== null) {
    const message = (rawError as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
    try {
      return JSON.stringify(rawError);
    } catch {
      return String(rawError);
    }
  }

  return String(rawError);
}

function withOriginalError(actionableMessage: string, originalError: string): string {
  return `${actionableMessage} (Original error: ${originalError})`;
}

function readInputString(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
}

function extractRangeFromInput(input: Record<string, unknown>): string | null {
  const directRange = readInputString(input, 'range');
  if (directRange) {
    return directRange;
  }

  const ranges = input.ranges;
  if (Array.isArray(ranges)) {
    const firstRange = ranges.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    if (firstRange) {
      return firstRange;
    }
  }

  const data = input.data;
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const range = (entry as { range?: unknown }).range;
      if (typeof range === 'string' && range.trim()) {
        return range;
      }
    }
  }

  return null;
}

function extractSpreadsheetIdFromMessage(message: string): string | null {
  const patterns = [
    /spreadsheets\/d\/([a-zA-Z0-9-_]+)/i,
    /\bspreadsheet[_\s-]?id[:=\s'"]+([a-zA-Z0-9-_]{8,})/i,
    /\bfor spreadsheet ['"]?([a-zA-Z0-9-_]{8,})['"]?/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function extractSpreadsheetId(message: string, input: Record<string, unknown>): string | null {
  return (
    extractSpreadsheetIdFromMessage(message) ??
    readInputString(input, 'spreadsheet_id', 'spreadsheetId')
  );
}

function normaliseSheetNameForDisplay(value: string): string {
  const trimmed = value.trim().replace(/!$/, '');

  if (trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/''/g, '\'');
  }

  return trimmed;
}

export function rewriteSheetsApiError(
  rawError: string | Error | unknown,
  ctx: SheetsApiErrorContext,
): string {
  const originalError = toErrorMessage(rawError);
  const message = originalError.trim();

  if (!message) {
    return originalError;
  }

  const parseRangeMatch = message.match(/Unable to parse range:\s*([^\n\r]+)/i);
  if (parseRangeMatch) {
    const parsedRange = parseRangeMatch[1].trim();

    if (parsedRange.endsWith('!')) {
      const sheetName = normaliseSheetNameForDisplay(parsedRange);
      return withOriginalError(
        `Sheet '${sheetName}' not found. Call \`list_workspace_spreadsheet_sheets\` to see available tabs.`,
        originalError,
      );
    }

    const range = parsedRange || extractRangeFromInput(ctx.input) || 'the provided range';
    return withOriginalError(
      `Range '${range}' could not be parsed. Common causes: (a) sheet name contains a space → wrap in single quotes (\`'My Sheet'!A1:B10\`); (b) reversed indices (\`B10:A1\` invalid); (c) sheet name with apostrophe needs escaping (\`'Bob''s Data'!A1\`).`,
      originalError,
    );
  }

  if (/Requested entity was not found/i.test(message)) {
    const spreadsheetId = extractSpreadsheetId(message, ctx.input);
    const spreadsheetLabel = spreadsheetId ? `'${spreadsheetId}'` : 'the provided spreadsheet';
    return withOriginalError(
      `Spreadsheet ${spreadsheetLabel} not found or not shared with this account. Verify the ID via \`extract_workspace_spreadsheet_id\` and confirm the account has access.`,
      originalError,
    );
  }

  if (/The caller does not have permission/i.test(message)) {
    const spreadsheetId = extractSpreadsheetId(message, ctx.input);
    const spreadsheetLabel = spreadsheetId ? `'${spreadsheetId}'` : 'the provided spreadsheet';
    return withOriginalError(
      `Account does not have access to spreadsheet ${spreadsheetLabel}. Ask the owner to share it, or switch accounts.`,
      originalError,
    );
  }

  if (/Quota exceeded|RATE_LIMIT_EXCEEDED/i.test(message)) {
    return withOriginalError(
      'Sheets API rate limit hit. Retry after a short delay, or batch reads via `batch_read_workspace_spreadsheet_values`.',
      originalError,
    );
  }

  if (/Invalid value at 'range\.startRowIndex'/i.test(message)) {
    return withOriginalError(
      'Grid index error: indices are **0-based and exclusive on end**. Row 1 = `start_row_index: 0, end_row_index: 1`. Column A = `start_column_index: 0, end_column_index: 1`.',
      originalError,
    );
  }

  return originalError;
}
