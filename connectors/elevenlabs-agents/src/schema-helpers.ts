import { z } from 'zod';
import { ElevenLabsError } from './types.js';

export const E164_REGEX = /^\+[1-9]\d{1,14}$/;

const INVALID_EPOCH_SECONDS_MESSAGE =
  'Expected epoch seconds (number) or a parseable ISO date string (e.g. "2026-01-01T12:00:00Z").';

function issueEpochSecondsError(
  ctx: z.RefinementCtx,
  message: string,
): typeof z.NEVER {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message,
  });
  return z.NEVER;
}

/**
 * Exported tool schemas must advertise both integer and string so strict MCP
 * hosts accept ISO date input before the connector gets a chance to coerce it.
 */
export function epochSecondsField(field = 'scheduled_time_unix') {
  return z.union([z.number().int(), z.string()]).transform((value, ctx) => {
    if (typeof value === 'number') {
      if (Math.abs(value) >= 1e12) {
        return issueEpochSecondsError(
          ctx,
          `${field} looks like milliseconds; pass epoch seconds (e.g. 1735689600) or an ISO date string.`,
        );
      }
      return value;
    }

    const trimmed = value.trim();
    if (trimmed === '') {
      return issueEpochSecondsError(ctx, INVALID_EPOCH_SECONDS_MESSAGE);
    }

    if (/^\d+$/.test(trimmed)) {
      const asNumber = Number(trimmed);
      if (Number.isFinite(asNumber) && Math.abs(asNumber) >= 1e12) {
        return issueEpochSecondsError(
          ctx,
          `${field} looks like milliseconds; pass epoch seconds (e.g. 1735689600) or an ISO date string.`,
        );
      }
      return issueEpochSecondsError(ctx, INVALID_EPOCH_SECONDS_MESSAGE);
    }

    const ms = new Date(trimmed).getTime();
    if (Number.isNaN(ms)) {
      return issueEpochSecondsError(ctx, INVALID_EPOCH_SECONDS_MESSAGE);
    }

    return Math.floor(ms / 1000);
  });
}

export function validateE164(field: string, value: string): void {
  if (!E164_REGEX.test(value)) {
    throw new ElevenLabsError(
      `${field} must be in E.164 format (e.g. +14155551234)`,
      'INVALID_PHONE_NUMBER',
      'Provide a phone number with a leading "+", a country code starting with a digit 1-9, and 1-14 additional digits. No spaces, dashes, parentheses, or other formatting characters.',
    );
  }
}
