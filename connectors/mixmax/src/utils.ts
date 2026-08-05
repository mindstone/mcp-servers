import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MixmaxError } from './types.js';

const coerceEpochMs = (val: unknown): unknown => {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed === '') return val;
  if (/^\d+$/.test(trimmed)) {
    // Digit-only strings are accepted ONLY in the unambiguous epoch-ms window
    // [1e12, 1e14) (≈ Sep 2001 → year 5138). Anything else — Unix SECONDS
    // ("1735689600" would silently be 1000x off) — is returned unchanged so
    // the refine rejects it with an actionable message. Never let digit-only
    // strings fall through to Date.parse: V8 parses "5" as year 2005.
    const num = Number(trimmed);
    return num >= 1e12 && num < 1e14 ? num : val;
  }
  const ms = new Date(trimmed).getTime();
  return Number.isNaN(ms) ? val : ms;
};

/**
 * STANDARD PATTERN for epoch-milliseconds fields (copied from
 * connectors/_template; see CONTRIBUTING.md "Date & timestamp fields").
 * Advertises both number and string in the exported JSON schema, coerces
 * parseable date strings to epoch ms at runtime, and rejects un-coercible
 * strings (including ambiguous digit-only strings such as Unix seconds).
 */
export const epochMsField = () =>
  z.preprocess(coerceEpochMs, z.union([z.number().int(), z.string()]))
    .refine((v): v is number => typeof v === 'number', {
      message: 'Expected epoch milliseconds (number), a 13-digit epoch-ms string, or a parseable date string (e.g. "2026-01-01").',
    });

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
