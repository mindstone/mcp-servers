import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OpusError } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/** IPv4 patterns for private, loopback, and link-local addresses. */
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
];

/**
 * Validate that a hostname/URL is safe for outbound requests. Rejects
 * private/loopback IPs, localhost, IPv6 loopback, and non-HTTPS schemes.
 *
 * @returns The validated hostname (scheme stripped).
 * @throws OpusError if the hostname is unsafe.
 */
export function validateHostname(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new OpusError(
      'Hostname must not be empty.',
      'INVALID_HOSTNAME',
      'Provide a valid public hostname.',
    );
  }

  let hostname = trimmed;
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'https') {
      throw new OpusError(
        `Scheme "${scheme}" is not allowed. Only HTTPS is permitted.`,
        'INVALID_HOSTNAME',
        'Use an HTTPS URL.',
      );
    }
    hostname = trimmed.slice(schemeMatch[0].length);

    const atIndex = hostname.indexOf('@');
    if (atIndex !== -1) {
      hostname = hostname.slice(atIndex + 1);
    }

    hostname = hostname.split(/[:/]/)[0];
  } else {
    const bracketMatch = hostname.match(/^\[([^\]]+)\]/);
    if (bracketMatch) {
      hostname = bracketMatch[1];
    } else if ((hostname.match(/:/g) || []).length === 1) {
      hostname = hostname.slice(0, hostname.indexOf(':'));
    }
  }

  const lower = hostname.toLowerCase();

  if (lower === 'localhost') {
    throw new OpusError(
      'localhost is not allowed.',
      'INVALID_HOSTNAME',
      'Provide a valid public hostname.',
    );
  }

  if (lower === '::1' || lower === '[::1]') {
    throw new OpusError(
      'IPv6 loopback address is not allowed.',
      'INVALID_HOSTNAME',
      'Provide a valid public hostname.',
    );
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(lower)) {
      throw new OpusError(
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
 *  - On success: returns the string result as a text content block.
 *  - On OpusError: returns a structured JSON error with code and resolution.
 *  - On unknown error: returns a generic error message.
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
      if (error instanceof OpusError) {
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
      // Unknown errors (network/runtime) may embed upstream-controlled text
      // (e.g. a fetched URL inside a fetch failure message), so the message
      // is enveloped before it becomes model-visible — invariant #6.
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: wrapUntrusted(errorMessage, 'opus:unhandled-error') ?? 'Unknown error',
            }),
          },
        ],
        isError: true,
      };
    }
  };
}
