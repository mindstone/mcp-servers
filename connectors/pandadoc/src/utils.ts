import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getApiKey } from './auth.js';
import { PandaDocError } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/** Bound on vendor-controlled text embedded in a model-visible error. */
const MAX_VENDOR_ERROR_CHARS = 500;

/**
 * Vendor-controlled response text (error bodies, info messages) embedded in a
 * model-visible result must be bounded AND enveloped, so a hostile or
 * compromised PandaDoc response cannot inject instructions or break out of
 * the untrusted-content boundary (AGENTS.md invariant #6).
 */
export function sanitizeVendorErrorText(text: string, source: string): string {
  const bounded =
    text.length > MAX_VENDOR_ERROR_CHARS
      ? `${text.slice(0, MAX_VENDOR_ERROR_CHARS)}…[truncated]`
      : text;
  return wrapUntrusted(bounded, source) ?? bounded;
}

/**
 * Remove the configured API key from a string before it reaches the model.
 * Runtime/proxy exceptions can echo request details; the key must never be
 * among them.
 */
export function redactApiKey(text: string): string {
  const key = getApiKey();
  if (!key) return text;
  return text.split(key).join('[redacted]');
}

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On PandaDocError: returns a structured JSON error with code and resolution.
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
      if (error instanceof PandaDocError) {
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
      const rawMessage = error instanceof Error ? error.message : String(error);
      // Unknown runtime errors are not vendor-authored, but they can echo
      // request details — redact the API key and bound the length before the
      // message reaches the model.
      const errorMessage = redactApiKey(rawMessage).slice(0, 1000);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: errorMessage }) }],
        isError: true,
      };
    }
  };
}
