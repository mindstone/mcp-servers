import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorkdayError } from './types.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On WorkdayError: returns a structured JSON error with code and resolution.
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
      if (error instanceof WorkdayError) {
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
      // Unknown errors: never emit an arbitrary thrown message to the model —
      // it may embed a fragment of a vendor/proxy-controlled response body
      // (e.g. a JSON parse error quoting hostile text). Log the detail to
      // stderr (not model-visible) and return a bounded, authored message.
      console.error('[Workday] Unexpected tool error:', error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'Unexpected error while executing the Workday tool. Check connector logs for details.',
            }),
          },
        ],
        isError: true,
      };
    }
  };
}
