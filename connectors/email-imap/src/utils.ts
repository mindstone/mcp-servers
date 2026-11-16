import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EmailImapError } from './types.js';
import { unwrapUntrusted, wrapUntrusted } from './untrusted-content.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

// A send, move or delete may have partly happened before the failure, so this
// never tells the caller a blind retry is safe.
const GENERIC_ERROR_RESOLUTION =
  'The operation may have partly completed. Check the mailbox (for example the Sent ' +
  'folder or the affected messages) before retrying; if the error persists, check the ' +
  'account settings in your MCP host.';

/**
 * Strip one envelope from every string in a tool's arguments that is wholly one
 * envelope, ignoring whitespace around it. Other strings, and keys (the tools'
 * own field names), are left unchanged.
 */
function unwrapArgs<T>(value: T): T {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const unwrapped = unwrapUntrusted(trimmed);
    return (unwrapped === trimmed ? value : unwrapped) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => unwrapArgs(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, unwrapArgs(item)]),
    ) as T;
  }
  return value;
}

/**
 * Wraps a tool handler with standard error handling.
 *
 * - Before the call: strips one untrusted-content envelope from every string
 *   argument that is wholly one envelope. The connector returns server text
 *   (message IDs, addresses, mailbox names, flags, attachment parts) enveloped,
 *   and callers pass those values back as they are; sent on unchanged, an
 *   enveloped Message-ID breaks reply threading and an enveloped address
 *   becomes a garbage recipient. Surrounding whitespace around the envelope
 *   is ignored; text that only contains an envelope is left as it is.
 * - On success: returns the string result as a text content block.
 * - On EmailImapError: returns a structured JSON error with code and resolution.
 * - On any other error: the message may carry IMAP/SMTP server response text,
 *   vendor SDK strings, mailbox names, or recipient data — all of it
 *   attacker-influenceable — so it is returned inside an untrusted-content
 *   envelope (AGENTS.md invariant #6) rather than as raw model-visible text,
 *   with the generic `INTERNAL_ERROR` code and resolution.
 *
 * Secrets are never exposed in error messages.
 */
export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string>,
): ToolHandler<T> {
  return async (args, extra) => {
    try {
      const result = await fn(unwrapArgs(args), extra);
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
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: enveloped,
              code: 'INTERNAL_ERROR',
              resolution: GENERIC_ERROR_RESOLUTION,
            }),
          },
        ],
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
