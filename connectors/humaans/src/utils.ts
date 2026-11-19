import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ADD_TOKEN_IN_SETTINGS, TOKEN_SCOPES, TOKEN_URL } from './auth.js';
import { HumaansError } from './types.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

const UNEXPECTED_ERROR = 'Unexpected error in the Humaans connector';

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On HumaansError: returns a structured JSON error with code and resolution.
 * - On any other error: returns a fixed message. Its own text can carry
 *   exception or vendor detail, so it never reaches the model or the log.
 */
export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string>,
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      const result = await fn(args, extra);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      if (error instanceof HumaansError) {
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
      console.error('Humaans connector: unexpected error in a tool handler');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, error: UNEXPECTED_ERROR, code: 'INTERNAL_ERROR' }),
          },
        ],
        isError: true,
      };
    }
  };
}

/** The result every data tool returns when no API key is set. */
export function notConfiguredResult(): string {
  return JSON.stringify({
    ok: false,
    error: 'Humaans API key not configured',
    resolution: ADD_TOKEN_IN_SETTINGS,
    next_step: {
      get_key_from: TOKEN_URL,
      scopes: TOKEN_SCOPES,
    },
  });
}
