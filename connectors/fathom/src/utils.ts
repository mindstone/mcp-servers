import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FathomError } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

// Cap vendor-supplied error text so a pathological response body cannot flood
// the model's context.
const MAX_ERROR_TEXT_CHARS = 500;

/**
 * Make externally-influenced error text safe for model output: truncate it,
 * then wrap it in an `<untrusted-content>` envelope (invariant #6). Vendor
 * error bodies and JSON.parse diagnostics can embed response-body fragments —
 * attacker-influenceable text that must be treated as data, not instructions.
 */
export function envelopeErrorText(text: string, source: string): string {
  const truncated =
    text.length > MAX_ERROR_TEXT_CHARS ? `${text.slice(0, MAX_ERROR_TEXT_CHARS)} [truncated]` : text;
  // `truncated` is always a string, so wrapUntrusted never returns undefined here.
  return wrapUntrusted(truncated, source) ?? truncated;
}

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On FathomError: returns a structured JSON error with code and resolution.
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
      if (error instanceof FathomError) {
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
      // Unhandled-error messages can embed response-body fragments (e.g.
      // JSON.parse diagnostics quote the malformed payload), so they are
      // enveloped as untrusted content too.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: envelopeErrorText(errorMessage, 'fathom:unhandled_error'),
            }),
          },
        ],
        isError: true,
      };
    }
  };
}
