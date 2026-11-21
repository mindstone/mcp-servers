import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ElevenLabsError } from './types.js';
import { getApiKey } from './auth.js';
import { createRedactor } from './api-sensitive.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On ElevenLabsError: returns a structured JSON error with code and resolution.
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
      const redactor = createRedactor([getApiKey()]);
      if (error instanceof ElevenLabsError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: redactor.text(error.message),
                code: error.code,
                resolution: redactor.text(error.resolution),
              }),
            },
          ],
          isError: true,
        };
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: redactor.wrap(errorMessage, 'elevenlabs:error') }) }],
        isError: true,
      };
    }
  };
}
