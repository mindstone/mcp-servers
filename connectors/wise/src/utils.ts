import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { WiseError } from './types.js';
import { loadCredentials } from './auth.js';
import { wiseFetch } from './client.js';
import type { WiseCredentials, WiseProfile } from './types.js';

type ToolHandler<T> = (args: T, extra: unknown) => Promise<CallToolResult>;

/** ISO 4217 currency codes are three uppercase letters. */
export function validateCurrency(value: string, fieldName = 'currency'): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new WiseError(
      `Invalid ${fieldName}: must be a 3-letter ISO 4217 currency code (e.g. "GBP").`,
      'INVALID_INPUT',
      `Provide a valid 3-letter currency code for ${fieldName}.`,
    );
  }
  return normalized;
}

/**
 * Validate a numeric Wise resource id (profile, balance, recipient, transfer).
 * Wise ids are int64; path segments must be digits only so a crafted value
 * cannot smuggle path traversal or query injection into the URL.
 */
export function validateNumericId(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WiseError(
      `Invalid ${fieldName}: must be a positive integer.`,
      'INVALID_INPUT',
      `Provide a valid numeric ${fieldName} as returned by the corresponding list tool.`,
    );
  }
  return value;
}

/**
 * Standard schema for an ISO 8601 date-time input (statement intervals,
 * activity windows). Accepts a full date-time or a plain YYYY-MM-DD date
 * (interpreted as UTC midnight) and normalizes to a `.toISOString()` value,
 * which is what the Wise API expects.
 */
export const isoDateTimeField = () =>
  z
    .string()
    .min(1)
    .refine(
      (value) => !Number.isNaN(Date.parse(value)),
      { message: 'Must be a parseable date or date-time string.' },
    )
    .transform((value) => new Date(value).toISOString());

/**
 * Wraps a tool handler with standard error handling.
 *
 * - On success: returns the string result as a text content block.
 * - On WiseError: returns a structured JSON error with code and resolution.
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
      if (error instanceof WiseError) {
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
 * Load the current credentials or return a model-visible "not connected"
 * payload. Tools call this first and return early when it yields a string.
 */
export function requireCredentials(): WiseCredentials | string {
  const credentials = loadCredentials();
  if (!credentials) {
    return JSON.stringify({
      ok: false,
      error: 'No Wise account connected.',
      code: 'NOT_CONNECTED',
      resolution:
        'Use configure_wise with an API token from wise.com (Settings → API tokens), ' +
        'or set the WISE_API_TOKEN environment variable in the host MCP configuration.',
    });
  }
  return credentials;
}

export function isCredentials(value: WiseCredentials | string): value is WiseCredentials {
  return typeof value !== 'string';
}

/**
 * Resolve which Wise profile to operate on.
 *
 * - If `profileId` is given, it is used directly.
 * - Otherwise the profiles endpoint is consulted: a single accessible
 *   profile is used implicitly; with several profiles (common when the user
 *   has both a personal and a business profile) the caller must choose,
 *   because picking a money-holding profile by guess is not recoverable.
 */
export async function resolveProfileId(
  credentials: WiseCredentials,
  profileId?: number,
): Promise<number> {
  if (profileId !== undefined) {
    return validateNumericId(profileId, 'profile_id');
  }
  const profiles = await wiseFetch<WiseProfile[]>(credentials.apiToken, '/v2/profiles');
  if (profiles.length === 0) {
    throw new WiseError(
      'No Wise profiles found for this token.',
      'NOT_FOUND',
      'Check that the API token belongs to an active Wise account.',
    );
  }
  if (profiles.length === 1) {
    return profiles[0].id;
  }
  throw new WiseError(
    `This token can access ${profiles.length} Wise profiles; specify profile_id.`,
    'AMBIGUOUS_PROFILE',
    'Call list_wise_profiles to see the available profile ids and pass the intended one as profile_id.',
  );
}
