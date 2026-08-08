import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { QuickBooksError } from './types.js';

/**
 * Shared date schema for QuickBooks tool inputs: strict YYYY-MM-DD shape plus
 * a real-calendar-date round-trip check, so 2026-13-99, 2026-02-30, unpadded
 * variants, and arbitrary strings are rejected before any outbound request.
 */
export const qboDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format.')
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    },
    { message: 'Date must be a real calendar date in YYYY-MM-DD format.' },
  );

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Escape a user-supplied string value for safe interpolation into a QBOQL query.
 * Escapes backslashes and single quotes to prevent injection.
 */
export function escapeQboql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Validate that an ID value contains only alphanumeric characters, hyphens, and underscores.
 * Throws QuickBooksError if the value contains unexpected characters.
 */
export function validateAlphanumericId(value: string, fieldName: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new QuickBooksError(
      `Invalid ${fieldName}: must contain only alphanumeric characters, hyphens, and underscores.`,
      'INVALID_INPUT',
      `Provide a valid ${fieldName} containing only letters, numbers, hyphens, and underscores.`,
    );
  }
}

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On QuickBooksError: returns a structured JSON error with code and resolution.
 * - On unknown error: returns a generic error message.
 *
 * Secrets are never exposed in error messages.
 */
export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string>,
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      const result = await fn(args, extra);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      if (error instanceof QuickBooksError) {
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
