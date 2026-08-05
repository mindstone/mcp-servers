import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConnectorError } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wraps a tool handler with standard error handling.
 */
export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string>,
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      const result = await fn(args, extra);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      if (error instanceof ConnectorError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: error.message,
                code: error.code,
                resolution: error.resolution,
              }),
            },
          ],
          isError: true,
        };
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: errorMessage }) }],
        isError: true,
      };
    }
  };
}

/**
 * Escape a string value for safe use in SOQL queries.
 *
 * Escapes the four characters that SOQL gives special meaning to:
 *   - `\\`  (backslash — the SOQL escape character)
 *   - `'`   (single quote — string delimiter; SOQL doubles the quote)
 *   - `%`   (LIKE wildcard — matches zero-or-more characters)
 *   - `_`   (LIKE wildcard — matches exactly one character)
 *
 * The wildcard characters MUST be escaped at every interpolation site so
 * that user-supplied substrings cannot expand the pattern beyond the
 * literal value the caller intended. For LIKE sites, prefer the
 * dedicated `escapeSOQLLike` helper for an explicit signal of intent.
 */
export function escapeSOQL(value: string): string {
  if (!value) return '';
  return value
    // Backslash MUST be escaped first to avoid double-escaping.
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * Escape a user-supplied search term for interpolation inside a SOSL
 * `FIND {term}` clause. SOSL gives special meaning to a different character
 * set than SOQL — every reserved character is backslash-escaped so the term
 * is always a single literal token and can never break out of the braces or
 * inject operators (AND/OR groupings, wildcards, field scoping).
 */
export function escapeSOSL(term: string): string {
  if (!term) return '';
  // Backslash MUST be escaped first to avoid double-escaping.
  return term.replace(/\\/g, '\\\\').replace(/([?&|!{}[\]()^~*:"+-])/g, '\\$1');
}

/**
 * Escape a user-supplied substring for interpolation inside a SOQL
 * `LIKE '%...%'` clause. Identical to `escapeSOQL` semantically (both
 * escape `\\`, `'`, `%`, `_`) but exists as a separate helper so every
 * `LIKE` site is unambiguously marked as wildcard-aware.
 */
export function escapeSOQLLike(value: string): string {
  return escapeSOQL(value);
}

/**
 * Validate that a field name is safe (alphanumeric + underscore only).
 */
export function isValidFieldName(field: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(field);
}

/**
 * Validate query field names (supports dot-notation for relationship fields).
 */
export function isValidQueryFieldName(field: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_.]*$/.test(field);
}

/**
 * Validate that an sObject API name is safe.
 */
export function validateObjectName(name: string): void {
  if (!name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new ConnectorError(
      `Invalid object name: "${name}"`,
      'INVALID_OBJECT_NAME',
      'Object names must start with a letter and contain only letters, numbers, and underscores (e.g., Account, Invoice__c)',
    );
  }
}

/**
 * Format a date string for SOQL (YYYY-MM-DD format required).
 */
export function formatSOQLDate(dateStr: string, paramName: string): string {
  const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    throw new ConnectorError(
      `Invalid ${paramName}: "${dateStr}"`,
      'INVALID_DATE_FORMAT',
      'Use YYYY-MM-DD format (e.g., "2026-01-09")',
    );
  }
  return match[1];
}

/**
 * Format a date or datetime string as a SOQL datetime literal (UTC).
 * Accepts a plain date ("2026-01-09", treated as midnight UTC) or an ISO 8601
 * datetime ("2026-01-09T14:30:00Z", offsets supported).
 */
export function formatSOQLDateTime(value: string, paramName: string): string {
  const dateOnly = value.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return `${dateOnly[1]}T00:00:00Z`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/.test(value)) {
    throw new ConnectorError(
      `Invalid ${paramName}: "${value}"`,
      'INVALID_DATE_FORMAT',
      'Use ISO 8601 (e.g., "2026-01-09T14:30:00Z") or a plain date ("2026-01-09", treated as midnight UTC)',
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ConnectorError(
      `Invalid ${paramName}: "${value}"`,
      'INVALID_DATE_FORMAT',
      'Use ISO 8601 (e.g., "2026-01-09T14:30:00Z") or a plain date ("2026-01-09", treated as midnight UTC)',
    );
  }
  return parsed.toISOString();
}

/**
 * Validate field names and return validated or default fields.
 */
export function validateFields(
  fields: string[],
  defaultFields: string[],
  validator: (field: string) => boolean = isValidFieldName,
): string[] {
  if (!fields || fields.length === 0) return defaultFields;
  const invalidFields = fields.filter((f) => !validator(f));
  if (invalidFields.length > 0) {
    throw new ConnectorError(
      `Invalid field names: ${invalidFields.join(', ')}`,
      'INVALID_FIELD_NAMES',
      'Field names must start with a letter and contain only letters, numbers, and underscores (e.g., Id, Name, Custom_Field__c)',
    );
  }
  return fields;
}

/**
 * Validate and merge custom fields into update data.
 */
export function validateAndMergeCustomFields(
  updateData: Record<string, unknown>,
  fields: Record<string, unknown>,
): void {
  const reservedFields = Object.keys(fields).filter((f) => f === 'Id' || f === 'id');
  if (reservedFields.length > 0) {
    throw new ConnectorError(
      'Cannot override record ID via fields parameter',
      'RESERVED_FIELD_OVERRIDE',
      'Remove "Id" from the fields object — Salesforce manages record IDs automatically',
    );
  }
  const invalidFields = Object.keys(fields).filter((f) => !isValidFieldName(f));
  if (invalidFields.length > 0) {
    throw new ConnectorError(
      `Invalid custom field names: ${invalidFields.join(', ')}`,
      'INVALID_FIELD_NAMES',
      'Field names must start with a letter and contain only letters, numbers, and underscores (e.g., Situation__c, Pain__c)',
    );
  }
  for (const [key, value] of Object.entries(fields)) {
    updateData[key] = value;
  }
}

export const ALLOWED_FILTER_OPERATORS = new Set(['=', '!=', '<', '>', '<=', '>=', 'LIKE']);

/**
 * Keys whose values are structural identifiers, not user-authored text: record
 * IDs are copied verbatim into follow-up tool calls (update, convert, link), so
 * enveloping them would corrupt that flow. Everything else reachable inside a
 * Salesforce record (names, emails, descriptions, subjects, …) is authored in
 * the external system and MUST be enveloped (AGENTS.md invariant #6, FOX-3490).
 */
function isStructuralRecordKey(key: string): boolean {
  return key === 'Id' || key === 'attributes' || key.endsWith('Id');
}

function wrapRecordValue(value: unknown, source: string): unknown {
  if (typeof value === 'string') return wrapUntrusted(value, source);
  if (Array.isArray(value)) return value.map((item) => wrapRecordValue(item, source));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isStructuralRecordKey(key) ? item : wrapRecordValue(item, source),
      ]),
    );
  }
  return value;
}

/**
 * Envelope every external-text field in a list of Salesforce records before
 * they are returned to the LLM. Structural keys (Id, *Id, attributes) pass
 * through raw so downstream tool calls can use them as identifiers.
 */
export function sanitizeRecords(records: unknown[], source: string): unknown[] {
  return records.map((record) => wrapRecordValue(record, source));
}

/**
 * Envelope every string inside an arbitrary external-data blob (report
 * results, metadata payloads), leaving structural keys (Id, *Id, attributes)
 * raw. Use for non-record response shapes where every value is org-authored.
 */
export function sanitizeExternalData<T>(value: T, source: string): T {
  return wrapRecordValue(value, source) as T;
}

export function checkSaveResult(
  result: { success: boolean; errors?: unknown[] } | Array<{ success: boolean; errors?: unknown[] }>,
  errorMessage: string,
): void {
  const res = Array.isArray(result) ? result[0] : result;
  if (!res.success) {
    throw new ConnectorError(errorMessage, 'UPDATE_ERROR', JSON.stringify(res.errors));
  }
}
