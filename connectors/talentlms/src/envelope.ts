/**
 * Fail-closed untrusted-content wrapping for TalentLMS payloads.
 *
 * AGENTS.md security invariant #6 requires every attacker-influenceable text
 * field returned by the API (course descriptions, user bios, group
 * descriptions, test/survey answers, user-authored names, custom fields) to
 * reach the model inside an `<untrusted-content>` envelope.
 *
 * This walker WRAPS EVERY STRING BY DEFAULT. A string passes through raw only
 * when BOTH hold:
 *
 * 1. its key names a narrow, enumerated system-generated primitive — an id the
 *    model must quote verbatim into a follow-up tool call, a vendor enum, a
 *    numeric value, a date/timestamp, or an HTTPS URL — never a prose field
 *    (names, descriptions, titles, messages, answers, custom fields, and any
 *    key this file does not know are always enveloped); and
 * 2. the value matches the strict grammar for that class (and is not
 *    instruction-shaped), so a hostile value under a structural-looking key
 *    name fails closed into an envelope instead of passing raw.
 *
 * Over-inclusion fails safe (a genuine id gets enveloped — cosmetic); the
 * previous allow-list design failed open (a prose field the list did not know
 * — `title`, `message`, `label`, `content`, `notes`, or anything TalentLMS
 * adds later — reached the model raw).
 */

import { wrapUntrusted } from './untrusted-content.js';

/** Ids (user/course/group/test/… ids) — the values follow-up tool calls quote verbatim. */
const ID_VALUE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Vendor-generated enums: role, status, completion_status, user_type, type, signup_method. */
const ENUM_VALUE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/** Counts, points, scores, prices, percentages, durations serialised as strings. */
const NUMERIC_VALUE_PATTERN = /^-?\$?\d{1,15}(?:\.\d{1,6})?$/;

/** Dates/timestamps (`2026-02-01`, `19/02/2026 10:30`, `10:00`) and the literal `Never`. */
const DATE_VALUE_PATTERN = /^(?:[\d/:.,+ -]{1,40}|Never)$/;

/** HTTPS URLs (SSO goto links, avatars). */
const URL_VALUE_PATTERN = /^https:\/\/[^\s<>"']{1,2048}$/;

const ENUM_KEYS = new Set([
  'role',
  'status',
  'completion_status',
  'user_type',
  'type',
  'signup_method',
]);

const NUMERIC_KEYS = new Set([
  'points',
  'level',
  'score',
  'price',
  'total_time',
  'progress_percentage',
  'completion_percentage',
  'total_users',
  'total_courses',
  'duration',
]);

const URL_KEYS = new Set(['url', 'avatar']);

type PrimitiveClass = 'id' | 'enum' | 'numeric' | 'date' | 'url';

function classifyPrimitiveKey(key: string): PrimitiveClass | null {
  if (key === 'id' || key.endsWith('_id')) return 'id';
  if (ENUM_KEYS.has(key)) return 'enum';
  if (NUMERIC_KEYS.has(key)) return 'numeric';
  if (
    key === 'date' ||
    key === 'time' ||
    key.endsWith('_date') ||
    key.endsWith('_on') ||
    key === 'last_updated' ||
    key === 'last_login' ||
    key === 'last_accessed'
  ) {
    return 'date';
  }
  if (URL_KEYS.has(key) || key.endsWith('_url')) return 'url';
  return null;
}

const PRIMITIVE_VALUE_PATTERNS: Record<PrimitiveClass, RegExp> = {
  id: ID_VALUE_PATTERN,
  enum: ENUM_VALUE_PATTERN,
  numeric: NUMERIC_VALUE_PATTERN,
  date: DATE_VALUE_PATTERN,
  url: URL_VALUE_PATTERN,
};

/**
 * Defense in depth on top of the class grammars: three or more all-letter
 * tokens joined by separators is an English phrase (`ignore_prior_instructions`
 * satisfies the id/enum alphabet), never a genuine id or enum — genuine ids
 * carry digits or are single tokens, and genuine enums are one word,
 * occasionally two. Rejecting the phrase shape fails closed (a wrapped
 * structural value is cosmetic; a raw injected one is not).
 */
function isInstructionShapedValue(value: string): boolean {
  const segments = value.split(/[_-]+/).filter((segment) => segment.length > 0);
  return segments.length >= 3 && segments.every((segment) => /^[A-Za-z]+$/.test(segment));
}

function isProvenPrimitive(key: string, value: string): boolean {
  const primitiveClass = classifyPrimitiveKey(key);
  if (!primitiveClass) return false;
  return (
    PRIMITIVE_VALUE_PATTERNS[primitiveClass].test(value) && !isInstructionShapedValue(value)
  );
}

/** `enrolled_users`-style collections of ids pass through only when every member is id-shaped. */
function isIdCollectionKey(key: string): boolean {
  return key.endsWith('_ids') || key === 'enrolled_users';
}

function wrapValue(value: unknown, source: string, key: string | undefined): unknown {
  if (typeof value === 'string') {
    return key !== undefined && isProvenPrimitive(key, value)
      ? value
      : wrapUntrusted(value, source);
  }
  if (Array.isArray(value)) {
    if (
      key !== undefined &&
      isIdCollectionKey(key) &&
      value.every((item) => typeof item === 'string' && ID_VALUE_PATTERN.test(item))
    ) {
      return [...value];
    }
    return value.map((item) => wrapValue(item, source, undefined));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [
        childKey,
        wrapValue(item, source, childKey),
      ]),
    );
  }
  // Non-string primitives (number, boolean, null) carry no injectable text.
  return value;
}

/**
 * Recursively wrap the external-text strings of a TalentLMS API payload.
 * Non-string leaves pass through unchanged; strings pass raw only when they
 * are narrowly proven system-generated primitives (see file header). Apply to
 * API response data BEFORE assembling the tool payload so connector-authored
 * fields (`ok`, `count`, `message`, …) are never mistaken for external text.
 */
export function wrapExternalTextFields<T>(value: T, source: string): T {
  return wrapValue(value, source, undefined) as T;
}
