import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TalentLMSError } from './types.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Optional pagination inputs shared by the list tools. TalentLMS returns 20
 * items per page by default; the v1 API addresses pages via colon-path
 * segments, e.g. /users/page_size:25,page_number:2.
 */
export const paginationFields = {
  page_size: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Items per page (TalentLMS default: 20, max: 1000).'),
  page_number: z.number().int().min(1).optional().describe('Page number to retrieve (default: 1).'),
};

export interface PaginationArgs {
  page_size?: number;
  page_number?: number;
}

/** Build a colon-path with pagination segments, e.g. /users/page_size:25,page_number:2. */
export function paginatedPath(base: string, args: PaginationArgs): string {
  const segments: string[] = [];
  if (args.page_size !== undefined) segments.push(`page_size:${args.page_size}`);
  if (args.page_number !== undefined) segments.push(`page_number:${args.page_number}`);
  return segments.length > 0 ? `${base}/${segments.join(',')}` : base;
}

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On TalentLMSError: returns a structured JSON error with code and resolution.
 * - On unknown error: logs the detail to server stderr and returns a generic,
 *   connector-authored message — an unexpected error's `.message` may embed
 *   third-party text, so it never reaches model output unsanitised.
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
      if (error instanceof TalentLMSError) {
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
      console.error('[talentlms] Unexpected tool error:', error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'Unexpected error processing the request. Details were logged to the server console.',
            }),
          },
        ],
        isError: true,
      };
    }
  };
}
