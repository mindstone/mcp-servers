import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { QuickBooksError } from './types.js';

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
