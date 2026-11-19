import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RunwayError, describeForLog, unexpectedError } from './types.js';
import { logError } from './key-filter.js';

/**
 * Encodes one value for use as a single URL path segment, so an ID can never
 * change which endpoint a request reaches. encodeURIComponent alone is not
 * enough: URL parsing still treats `.` and `..` (and their %2E forms) as
 * directory steps, so those and the empty string are refused.
 */
export function pathSegment(value: string): string {
  if (value === '' || value === '.' || value === '..') {
    throw new RunwayError(
      `Invalid ID: ${JSON.stringify(value)}`,
      'INVALID_ARGUMENTS',
      'Pass the ID exactly as Runway returned it.',
    );
  }
  return encodeURIComponent(value);
}

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On RunwayError: returns a structured JSON error with code and resolution.
 * - On unknown error: returns fixed UNEXPECTED_ERROR text (detail to stderr, key removed).
 *
 * Credentials in results are removed at the transport (`filterTransport`).
 */
export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string>,
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      const result = await fn(args, extra);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      if (error instanceof RunwayError) {
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
      // Unknown errors can quote anything (a URL, a header, the key), so the
      // result gets fixed text and the detail goes to stderr with the key removed.
      logError(`[Runway] unexpected error: ${describeForLog(error)}`);
      const safe = unexpectedError();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, error: safe.message, code: safe.code, resolution: safe.resolution }),
          },
        ],
        isError: true,
      };
    }
  };
}
