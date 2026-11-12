import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EmailImapError } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On EmailImapError: returns a structured JSON error with code and resolution.
 * - On any other error: the message may carry IMAP/SMTP server response text,
 *   vendor SDK strings, mailbox names, or recipient data — all of it
 *   attacker-influenceable — so it is returned inside an untrusted-content
 *   envelope (AGENTS.md invariant #6) rather than as raw model-visible text.
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
      if (error instanceof EmailImapError) {
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
      const enveloped =
        wrapUntrusted(errorMessage, 'email-imap:external-error') ?? 'Unknown error';
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: enveloped }) }],
        isError: true,
      };
    }
  };
}

/**
 * Plain-text fallback for an HTML-only message: drop tags, collapse whitespace.
 * Each "<" scans only up to the next "<" or ">": linear time, and a stray "<"
 * in the text is kept, not swallowed. A rare quoted attribute holding "<"
 * leaves part of that tag in the text; the message's own text is still kept.
 */
export function htmlToPlainText(html: string): string {
  return html.replace(/<[^<>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
