export interface ParsedA1 {
  sheetName?: string;
  startCol?: string;
  startRow?: number;
  endCol?: string;
  endRow?: number;
  isUnbounded: boolean;
  isFullSheet: boolean;
  raw: string;
}

interface ParsedA1Token {
  col?: string;
  row?: number;
}

interface ParsedA1Bounds {
  startCol?: string;
  startRow?: number;
  endCol?: string;
  endRow?: number;
  isUnbounded: boolean;
}

const SIMPLE_SHEET_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const A1_CELL_TOKEN_REGEX = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)$/;
const A1_COLUMN_TOKEN_REGEX = /^\$?([A-Za-z]{1,3})$/;
const A1_ROW_TOKEN_REGEX = /^([1-9]\d*)$/;
const R1C1_REFERENCE_REGEX = /^R[1-9]\d*C[1-9]\d*(?::R[1-9]\d*C[1-9]\d*)?$/i;

export class ActionableA1Error extends Error {
  readonly suggestion: string;

  constructor(message: string, suggestion: string) {
    super(message);
    this.name = 'ActionableA1Error';
    this.suggestion = suggestion;
  }
}

function tryUnquoteSheetName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed.startsWith('\'') || !trimmed.endsWith('\'')) {
    return null;
  }

  const inner = trimmed.slice(1, -1);
  let output = '';

  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char === '\'') {
      if (inner[i + 1] !== '\'') {
        return null;
      }
      output += '\'';
      i += 1;
      continue;
    }
    output += char;
  }

  return output;
}

function parseSheetNameToken(sheetPart: string): string | null {
  const trimmed = sheetPart.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('\'')) {
    return tryUnquoteSheetName(trimmed);
  }

  return trimmed;
}

function splitSheetAndRange(input: string): { sheetPart: string; rangePart: string } | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('\'')) {
    let cursor = 1;
    while (cursor < trimmed.length) {
      if (trimmed[cursor] === '\'') {
        if (trimmed[cursor + 1] === '\'') {
          cursor += 2;
          continue;
        }
        cursor += 1;
        if (trimmed[cursor] === '!') {
          return {
            sheetPart: trimmed.slice(0, cursor),
            rangePart: trimmed.slice(cursor + 1),
          };
        }
        break;
      }
      cursor += 1;
    }
  }

  const bangIndex = trimmed.indexOf('!');
  if (bangIndex === -1) {
    return null;
  }

  return {
    sheetPart: trimmed.slice(0, bangIndex),
    rangePart: trimmed.slice(bangIndex + 1),
  };
}

function parseA1Token(token: string): ParsedA1Token | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  const cellMatch = trimmed.match(A1_CELL_TOKEN_REGEX);
  if (cellMatch) {
    return {
      col: cellMatch[1].toUpperCase(),
      row: Number.parseInt(cellMatch[2], 10),
    };
  }

  const columnMatch = trimmed.match(A1_COLUMN_TOKEN_REGEX);
  if (columnMatch) {
    return {
      col: columnMatch[1].toUpperCase(),
    };
  }

  const rowMatch = trimmed.match(A1_ROW_TOKEN_REGEX);
  if (rowMatch) {
    return {
      row: Number.parseInt(rowMatch[1], 10),
    };
  }

  return null;
}

function parseRangeBounds(rangePart: string): ParsedA1Bounds | null {
  const trimmed = rangePart.trim();
  if (!trimmed) {
    return null;
  }

  const segments = trimmed.split(':');
  if (segments.length > 2) {
    return null;
  }

  const start = parseA1Token(segments[0]);
  if (!start) {
    return null;
  }

  if (segments.length === 1) {
    const isUnbounded = start.col === undefined || start.row === undefined;
    return {
      startCol: start.col,
      startRow: start.row,
      endCol: start.col,
      endRow: start.row,
      isUnbounded,
    };
  }

  const end = parseA1Token(segments[1]);
  if (!end) {
    return null;
  }

  return {
    startCol: start.col,
    startRow: start.row,
    endCol: end.col,
    endRow: end.row,
    isUnbounded:
      start.col === undefined ||
      end.col === undefined ||
      start.row === undefined ||
      end.row === undefined,
  };
}

function isBareA1LikeReference(input: string): boolean {
  return parseRangeBounds(input) !== null;
}

function looksLikeR1C1Reference(input: string): boolean {
  return R1C1_REFERENCE_REGEX.test(input.trim());
}

export function parseA1Range(range: string): ParsedA1 | null {
  const trimmed = range.trim();
  if (!trimmed) {
    return null;
  }

  const split = splitSheetAndRange(trimmed);
  if (split) {
    const sheetName = parseSheetNameToken(split.sheetPart);
    if (!sheetName) {
      return null;
    }

    const bounds = parseRangeBounds(split.rangePart);
    if (!bounds) {
      return null;
    }

    return {
      sheetName,
      ...bounds,
      isFullSheet: false,
      raw: range,
    };
  }

  const bounds = parseRangeBounds(trimmed);
  if (bounds) {
    return {
      ...bounds,
      isFullSheet: false,
      raw: range,
    };
  }

  const sheetName = parseSheetNameToken(trimmed);
  if (!sheetName) {
    return null;
  }

  return {
    sheetName,
    isUnbounded: true,
    isFullSheet: true,
    raw: range,
  };
}

export function quoteSheetNameIfNeeded(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '\'\'';
  }

  const unquoted = tryUnquoteSheetName(trimmed) ?? trimmed;
  const escaped = unquoted.replace(/'/g, '\'\'');
  const needsQuotes =
    !SIMPLE_SHEET_NAME_REGEX.test(unquoted) ||
    isBareA1LikeReference(unquoted) ||
    looksLikeR1C1Reference(unquoted);

  return needsQuotes ? `'${escaped}'` : unquoted;
}

export function normaliseA1Range(range: string): string {
  const trimmed = range.trim();
  if (!trimmed) {
    return trimmed;
  }

  const split = splitSheetAndRange(trimmed);
  if (split) {
    const sheetName = parseSheetNameToken(split.sheetPart);
    if (!sheetName) {
      return trimmed;
    }

    const normalisedSheet = quoteSheetNameIfNeeded(sheetName);
    const normalisedRangePart = split.rangePart.trim();
    if (!normalisedRangePart) {
      return `${normalisedSheet}!`;
    }

    return `${normalisedSheet}!${normalisedRangePart}`;
  }

  const parsed = parseA1Range(trimmed);
  if (parsed && !parsed.sheetName) {
    return trimmed;
  }

  const sheetName = parseSheetNameToken(trimmed);
  if (!sheetName) {
    return trimmed;
  }

  return quoteSheetNameIfNeeded(sheetName);
}

export function isLikelyUnbounded(range: string, maxBoundedRows = 1000): boolean {
  const parsed = parseA1Range(range);
  if (!parsed) {
    return false;
  }

  if (parsed.isUnbounded) {
    return true;
  }

  const rowCount = rowCountFromA1(range);
  return rowCount !== null && rowCount > maxBoundedRows;
}

export function rowCountFromA1(range: string): number | null {
  const parsed = parseA1Range(range);
  if (!parsed || parsed.isUnbounded) {
    return null;
  }

  if (parsed.startRow === undefined || parsed.endRow === undefined) {
    return null;
  }

  const rowCount = parsed.endRow - parsed.startRow + 1;
  return rowCount > 0 ? rowCount : null;
}
