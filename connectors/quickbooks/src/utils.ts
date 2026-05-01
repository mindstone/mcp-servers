import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { QuickBooksError } from './types.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Secure-by-default write gate for QuickBooks mutating tools.
 *
 * QuickBooks production writes (creating invoices, bills, customers, vendors,
 * etc.) are gated behind the `QB_ALLOW_PROD_WRITES` environment variable. The
 * value MUST be exactly the string `'1'` — any other value (including unset,
 * empty string, `'true'`, `'yes'`, `'TRUE'`, or `'0'`) keeps the gate closed.
 *
 * This guard prevents an LLM agent from accidentally writing to a real
 * QuickBooks production company. Hosts that intend writes to occur must
 * explicitly opt in by setting the environment variable.
 *
 * Throws a `QuickBooksError` with the env-var name in both the message and
 * the `code`/`resolution` so downstream `withErrorHandling` surfaces the
 * variable name to the caller.
 */
export function requireProdWritesEnabled(): void {
  if (process.env.QB_ALLOW_PROD_WRITES !== '1') {
    throw new QuickBooksError(
      'QuickBooks mutating tools refuse to run unless QB_ALLOW_PROD_WRITES=1 is set. ' +
        'This guard is secure-by-default: it prevents an LLM agent from accidentally ' +
        'performing a destructive write against a real QuickBooks production company. ' +
        'Set QB_ALLOW_PROD_WRITES=1 in the host environment only when you intend ' +
        'production writes to occur.',
      'QB_ALLOW_PROD_WRITES_REQUIRED',
      'Set the QB_ALLOW_PROD_WRITES=1 environment variable in the host MCP configuration ' +
        'to opt in to QuickBooks production writes. Read-only tools (list/get/search) are ' +
        'unaffected by this gate.',
    );
  }
}

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
