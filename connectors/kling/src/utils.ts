import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { KlingError } from './types.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On KlingError: returns a structured JSON error with code and resolution.
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
      if (error instanceof KlingError) {
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

/**
 * Coercion for epoch-ms fields, copied from the repo template's standard
 * pattern (see CONTRIBUTING.md "Date & timestamp fields"). Digit-only
 * strings are accepted only in the unambiguous epoch-ms window [1e12, 1e14)
 * — Unix SECONDS strings are rejected rather than silently parsed 1000x off,
 * and digit-only strings never reach Date.parse (V8 reads "5" as 2005).
 */
const coerceEpochMs = (val: unknown): unknown => {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed === '') return val;
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    return num >= 1e12 && num < 1e14 ? num : val;
  }
  const ms = new Date(trimmed).getTime();
  return Number.isNaN(ms) ? val : ms;
};

/**
 * Epoch-milliseconds input field: advertises `number | string` in the
 * exported JSON schema so strict MCP hosts don't reject ISO date strings at
 * the boundary, coerces parseable date strings to epoch ms at runtime, and
 * rejects un-coercible strings with an actionable message.
 */
export const epochMsField = () =>
  z
    .preprocess(coerceEpochMs, z.union([z.number().int(), z.string()]))
    .refine((v): v is number => typeof v === 'number', {
      message:
        'Expected epoch milliseconds (number), a 13-digit epoch-ms string, or a parseable date string (e.g. "2026-01-01").',
    });
