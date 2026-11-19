import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NanoBananaError, unexpectedError } from './types.js';
import { logError } from './key-filter.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On NanoBananaError: returns a structured JSON error with code and resolution.
 * - On unknown error: returns fixed text; the raw message is never returned.
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
      if (error instanceof NanoBananaError) {
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
      return unexpectedErrorResult(error);
    }
  };
}

/**
 * The result for an error no handler recognised. Its text can quote anything,
 * including a submitted key, so only its class name goes to stderr.
 */
export function unexpectedErrorResult(error: unknown): CallToolResult {
  logError(`[NanoBanana] unexpected error: ${error instanceof Error ? error.name : typeof error}`);
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
