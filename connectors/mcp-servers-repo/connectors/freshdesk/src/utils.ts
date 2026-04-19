import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FreshdeskError } from './types.js';

/**
 * Strict subdomain regex: only lowercase alphanumerics and hyphens,
 * must start and end with an alphanumeric character.
 * Prevents API key exfiltration via URL manipulation.
 */
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Validates that a Freshdesk subdomain is a safe, single-label hostname component.
 *
 * Rejects any domain containing `/`, `@`, `?`, `#`, `.`, `%`, whitespace, or
 * other characters that could redirect API requests to an attacker-controlled host.
 *
 * @throws {FreshdeskError} with code INVALID_SUBDOMAIN if validation fails
 */
export function validateSubdomain(domain: string): void {
  if (!domain || !domain.trim()) {
    throw new FreshdeskError(
      'Freshdesk subdomain cannot be empty',
      'INVALID_SUBDOMAIN',
      'Provide a valid Freshdesk subdomain (e.g. "acme" for acme.freshdesk.com).',
    );
  }

  const trimmed = domain.trim();
  if (!SUBDOMAIN_RE.test(trimmed)) {
    throw new FreshdeskError(
      `Invalid Freshdesk subdomain: "${trimmed}". Only lowercase alphanumeric characters and hyphens are allowed.`,
      'INVALID_SUBDOMAIN',
      'Provide just the subdomain part (e.g. "acme" for acme.freshdesk.com). Do not include the full URL, dots, or special characters.',
    );
  }
}

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On FreshdeskError: returns a structured JSON error with code and resolution.
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
      if (error instanceof FreshdeskError) {
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
