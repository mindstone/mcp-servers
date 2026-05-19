import { parseA1Range, quoteSheetNameIfNeeded } from './a1Utils.js';
import type { CellTriad } from './types.js';

export interface FormulaCellRef {
  a1: string;
  formula: string;
  proposedValue: unknown;
}

export interface SuspiciousWriteWarning {
  kind:
    | 'looks_like_sum'
    | 'looks_like_average'
    | 'looks_like_fill_down'
    | 'looks_like_count'
    | 'looks_like_raw_formula_literal';
  column: string;
  rows: number[];
  suggestedFormula: string;
  detail: string;
}

export interface ExistingFormulaCell {
  sheetTitle: string;
  rowIndex: number;
  columnIndex: number;
  formula: string;
}

export interface DetectSuspiciousWritesInput {
  targetRange: string;
  proposedValues: ReadonlyArray<ReadonlyArray<unknown>>;
  adjacentContext?: {
    aboveRows?: ReadonlyArray<ReadonlyArray<CellTriad>>;
    leftCols?: ReadonlyArray<ReadonlyArray<CellTriad>>;
  };
}

interface ParsedTargetRange {
  sheetName?: string;
  startRow: number;
  startColumnIndex: number;
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

function parseTargetRange(targetRange: string): ParsedTargetRange | null {
  const parsed = parseA1Range(targetRange);
  if (!parsed) {
    return null;
  }

  const startRow = parsed.startRow ?? 1;
  const startColumnLetter = parsed.startCol ?? 'A';
  const startColumn = columnLetterToIndex(startColumnLetter);
  if (startColumn <= 0) {
    return null;
  }

  return {
    sheetName: parsed.sheetName,
    startRow,
    startColumnIndex: startColumn - 1,
  };
}

function toFormulaLookupKey(sheetName: string | undefined, rowIndex: number, columnIndex: number): string {
  return `${sheetName ?? '*'}:${rowIndex}:${columnIndex}`;
}

function formatCellA1(
  sheetName: string | undefined,
  rowIndex: number,
  columnIndex: number,
): string {
  const cell = `${columnIndexToLetter(columnIndex + 1)}${rowIndex + 1}`;
  if (!sheetName) {
    return cell;
  }
  return `${quoteSheetNameIfNeeded(sheetName)}!${cell}`;
}

function toNumeric(value: unknown): number | null {
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

function isEmptyTriadCell(cell: CellTriad | undefined): boolean {
  if (!cell) {
    return true;
  }

  if (cell.formula) {
    return false;
  }

  if (cell.value === null || cell.value === undefined) {
    return true;
  }

  return typeof cell.value === 'string' && cell.value.trim() === '';
}

function approximatelyEqual(left: number, right: number, tolerance = 0.001): boolean {
  return Math.abs(left - right) <= tolerance;
}

function detectIdenticalNumericFillDown(
  targetRange: ParsedTargetRange,
  proposedValues: ReadonlyArray<ReadonlyArray<unknown>>,
): SuspiciousWriteWarning[] {
  const warnings: SuspiciousWriteWarning[] = [];
  if (proposedValues.length <= 3) {
    return warnings;
  }

  const columnCount = Math.max(0, ...proposedValues.map((row) => row.length));
  for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
    const numericValues: number[] = [];
    let allNumeric = true;

    for (let rowOffset = 0; rowOffset < proposedValues.length; rowOffset += 1) {
      const value = toNumeric(proposedValues[rowOffset]?.[columnOffset]);
      if (value === null) {
        allNumeric = false;
        break;
      }
      numericValues.push(value);
    }

    if (!allNumeric || numericValues.length <= 3) {
      continue;
    }

    const first = numericValues[0];
    const allEqual = numericValues.every((value) => approximatelyEqual(value, first));
    if (!allEqual) {
      continue;
    }

    const absoluteColumnIndex = targetRange.startColumnIndex + columnOffset;
    const column = columnIndexToLetter(absoluteColumnIndex + 1);
    const startRow = targetRange.startRow;
    const endRow = targetRange.startRow + proposedValues.length - 1;
    const rows = Array.from({ length: proposedValues.length }, (_, index) => startRow + index);
    const sourceColumn = columnIndexToLetter(Math.max(1, absoluteColumnIndex) as number);

    warnings.push({
      kind: 'looks_like_fill_down',
      column,
      rows,
      suggestedFormula: `=${sourceColumn}${startRow}`,
      detail: `Possible formula opportunity: column ${column} rows ${startRow}-${endRow} are identical. If derived from another cell, consider a formula like =${sourceColumn}${startRow}.`,
    });
  }

  return warnings;
}

export function detectFormulaOverwrite(
  targetRange: string,
  proposedValues: ReadonlyArray<ReadonlyArray<unknown>>,
  existingFormulaCells: ReadonlyArray<ExistingFormulaCell>,
): FormulaCellRef[] {
  const parsedTarget = parseTargetRange(targetRange);
  if (!parsedTarget || proposedValues.length === 0) {
    return [];
  }

  const targetSheet = parsedTarget.sheetName;
  const formulaLookup = new Map<string, ExistingFormulaCell>();
  for (const cell of existingFormulaCells) {
    if (targetSheet && cell.sheetTitle !== targetSheet) {
      continue;
    }
    formulaLookup.set(toFormulaLookupKey(cell.sheetTitle, cell.rowIndex, cell.columnIndex), cell);
    if (!targetSheet) {
      formulaLookup.set(toFormulaLookupKey(undefined, cell.rowIndex, cell.columnIndex), cell);
    }
  }

  const collisions: FormulaCellRef[] = [];
  for (let rowOffset = 0; rowOffset < proposedValues.length; rowOffset += 1) {
    const row = proposedValues[rowOffset] ?? [];
    for (let columnOffset = 0; columnOffset < row.length; columnOffset += 1) {
      const rowIndex = parsedTarget.startRow - 1 + rowOffset;
      const columnIndex = parsedTarget.startColumnIndex + columnOffset;
      const directKey = toFormulaLookupKey(targetSheet, rowIndex, columnIndex);
      const wildcardKey = toFormulaLookupKey(undefined, rowIndex, columnIndex);
      const match = formulaLookup.get(directKey) ?? formulaLookup.get(wildcardKey);
      if (!match) {
        continue;
      }

      collisions.push({
        a1: formatCellA1(match.sheetTitle || targetSheet, rowIndex, columnIndex),
        formula: match.formula,
        proposedValue: row[columnOffset],
      });
    }
  }

  return collisions;
}

export function detectSuspiciousWrites(input: DetectSuspiciousWritesInput): SuspiciousWriteWarning[] {
  const parsedTarget = parseTargetRange(input.targetRange);
  if (!parsedTarget || input.proposedValues.length === 0) {
    return [];
  }

  const warnings = detectIdenticalNumericFillDown(parsedTarget, input.proposedValues);

  const singleCellWrite =
    input.proposedValues.length === 1
    && (input.proposedValues[0]?.length ?? 0) === 1;
  if (!singleCellWrite) {
    return warnings;
  }

  const targetValue = toNumeric(input.proposedValues[0][0]);
  if (targetValue === null) {
    return warnings;
  }

  const aboveRows = input.adjacentContext?.aboveRows ?? [];
  if (aboveRows.length === 0 || parsedTarget.startRow <= 1) {
    return warnings;
  }

  const column = columnIndexToLetter(parsedTarget.startColumnIndex + 1);
  const targetRow = parsedTarget.startRow;
  const priorRangeStart = Math.max(1, targetRow - aboveRows.length);
  const priorRange = `${column}${priorRangeStart}:${column}${targetRow - 1}`;
  const targetCellA1 = formatCellA1(parsedTarget.sheetName, targetRow - 1, parsedTarget.startColumnIndex);

  const aboveValues = aboveRows
    .map((row) => row[0])
    .map((cell) => toNumeric(cell?.value))
    .filter((value): value is number => value !== null);

  if (aboveValues.length > 0) {
    const sum = aboveValues.reduce((total, value) => total + value, 0);
    const average = sum / aboveValues.length;

    if (approximatelyEqual(targetValue, sum)) {
      warnings.push({
        kind: 'looks_like_sum',
        column,
        rows: [targetRow],
        suggestedFormula: `=SUM(${priorRange})`,
        detail: `Possible formula opportunity: ${targetCellA1} = ${targetValue} equals SUM of ${priorRange}. Consider =SUM(${priorRange}).`,
      });
    }

    if (approximatelyEqual(targetValue, average)) {
      warnings.push({
        kind: 'looks_like_average',
        column,
        rows: [targetRow],
        suggestedFormula: `=AVERAGE(${priorRange})`,
        detail: `Possible formula opportunity: ${targetCellA1} = ${targetValue} equals AVERAGE of ${priorRange}. Consider =AVERAGE(${priorRange}).`,
      });
    }
  }

  const nonEmptyCount = aboveRows.filter((row) => !isEmptyTriadCell(row[0])).length;
  if (Number.isInteger(targetValue) && targetValue === nonEmptyCount) {
    warnings.push({
      kind: 'looks_like_count',
      column,
      rows: [targetRow],
      suggestedFormula: `=COUNTA(${priorRange})`,
      detail: `Possible formula opportunity: ${targetCellA1} = ${targetValue} equals count of non-empty cells in ${priorRange}. Consider =COUNTA(${priorRange}).`,
    });
  }

  return warnings;
}

export function detectRawFormulaLiterals(
  targetRange: string,
  proposedValues: ReadonlyArray<ReadonlyArray<unknown>>,
  valueInputOption: 'USER_ENTERED' | 'RAW',
): SuspiciousWriteWarning[] {
  if (valueInputOption !== 'RAW' || proposedValues.length === 0) {
    return [];
  }

  const parsedTarget = parseTargetRange(targetRange);
  if (!parsedTarget) {
    return [];
  }

  const warnings: SuspiciousWriteWarning[] = [];
  for (let rowOffset = 0; rowOffset < proposedValues.length; rowOffset += 1) {
    const row = proposedValues[rowOffset] ?? [];
    for (let columnOffset = 0; columnOffset < row.length; columnOffset += 1) {
      const value = row[columnOffset];
      if (typeof value !== 'string' || !value.trim().startsWith('=')) {
        continue;
      }

      const rowNumber = parsedTarget.startRow + rowOffset;
      const absoluteColumnIndex = parsedTarget.startColumnIndex + columnOffset;
      const column = columnIndexToLetter(absoluteColumnIndex + 1);
      const a1 = formatCellA1(parsedTarget.sheetName, rowNumber - 1, absoluteColumnIndex);

      warnings.push({
        kind: 'looks_like_raw_formula_literal',
        column,
        rows: [rowNumber],
        suggestedFormula: value.trim(),
        detail: `Possible formula opportunity: cell ${a1} contains '${value.trim()}' as text because value_input_option is RAW. Use USER_ENTERED to evaluate as a formula.`,
      });
    }
  }

  return warnings;
}
