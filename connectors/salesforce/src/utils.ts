import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConnectorError } from './types.js';

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
 */
export function escapeSOQL(value: string): string {
  if (!value) return '';
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
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

export function checkSaveResult(
  result: { success: boolean; errors?: unknown[] } | Array<{ success: boolean; errors?: unknown[] }>,
  errorMessage: string,
): void {
  const res = Array.isArray(result) ? result[0] : result;
  if (!res.success) {
    throw new ConnectorError(errorMessage, 'UPDATE_ERROR', JSON.stringify(res.errors));
  }
}
