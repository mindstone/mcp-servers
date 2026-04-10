import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConnectorError } from './types.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/** IPv4 patterns for private, loopback, and link-local addresses. */
const PRIVATE_IP_PATTERNS = [
  /^127\./,             // loopback
  /^10\./,              // class A private
  /^172\.(1[6-9]|2\d|3[01])\./,  // class B private
  /^192\.168\./,        // class C private
  /^169\.254\./,        // link-local
  /^0\./,               // "this" network
];

/**
 * Validate that a hostname/URL is safe for outbound requests.
 *
 * Rejects:
 * - Private/loopback IPs (127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, 0.x)
 * - IPv6 loopback (::1)
 * - localhost
 * - Non-HTTPS schemes (http://, ftp://, etc.)
 *
 * @param input - A hostname, or a URL string (with or without scheme).
 * @returns The validated hostname (scheme stripped).
 * @throws ConnectorError if the hostname is unsafe.
 */
export function validateHostname(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ConnectorError(
      'Hostname must not be empty.',
      'INVALID_HOSTNAME',
      'Provide a valid public hostname.',
    );
  }

  // If it looks like a URL, parse scheme and hostname
  let hostname = trimmed;
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'https') {
      throw new ConnectorError(
        `Scheme "${scheme}" is not allowed. Only HTTPS is permitted.`,
        'INVALID_HOSTNAME',
        'Use an HTTPS URL.',
      );
    }
    // Strip scheme and extract hostname (before port/path)
    hostname = trimmed.slice(schemeMatch[0].length).split(/[:/]/)[0];
  }

  const lower = hostname.toLowerCase();

  // Reject localhost
  if (lower === 'localhost') {
    throw new ConnectorError(
      'localhost is not allowed.',
      'INVALID_HOSTNAME',
      'Provide a valid public hostname.',
    );
  }

  // Reject IPv6 loopback
  if (lower === '::1' || lower === '[::1]') {
    throw new ConnectorError(
      'IPv6 loopback address is not allowed.',
      'INVALID_HOSTNAME',
      'Provide a valid public hostname.',
    );
  }

  // Reject private IPv4 ranges
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(lower)) {
      throw new ConnectorError(
        `Private IP address "${hostname}" is not allowed.`,
        'INVALID_HOSTNAME',
        'Provide a valid public hostname.',
      );
    }
  }

  return hostname;
}

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On ConnectorError: returns a structured JSON error with code and resolution.
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
      if (error instanceof ConnectorError) {
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
