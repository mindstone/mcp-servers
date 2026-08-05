import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MixmaxError } from './types.js';


/**
 * Validate a Mixmax API response body against a Zod schema. Throws a
 * MixmaxError with an actionable resolution instead of leaking a raw ZodError
 * when the vendor changes a response shape.
 */
export function parseApiResponse<S extends z.ZodType>(
  schema: S,
  data: unknown,
  resource: string,
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new MixmaxError(
      `Unexpected ${resource} response shape from the Mixmax API`,
      'INVALID_API_RESPONSE',
      'The Mixmax API returned data in an unexpected format. Try again, or update the connector if the problem persists.',
    );
  }
  return result.data as z.infer<S>;
}

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On MixmaxError: returns a structured JSON error with code and resolution.
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
      if (error instanceof MixmaxError) {
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
