/**
 * Envelope-wrapping for the external-text fields Vanta returns to the LLM.
 *
 * Vanta tool handlers return raw Manage Vanta API objects inside the tool
 * payload, so attacker-influenceable text (vendor notes, control and policy
 * descriptions, risk-scenario prose, integration error messages, people
 * names, scanner-authored package identifiers) is nested inside those objects
 * rather than passed individually. This module is the single, auditable place
 * that reaches `wrapUntrusted` (AGENTS.md security invariant #6, FOX-3490).
 *
 * **Deny-by-default walk.** Every string anywhere in the response data is
 * enveloped unless a narrow structural exemption applies. An earlier
 * allowlist-of-prose-keys design failed open: any free-text field whose key
 * was not enumerated (including fields Vanta adds later, and scanner-authored
 * fields like `packageIdentifier`) reached the model unenveloped — the same
 * lesson `connectors/elevenlabs-agents/src/sanitize.ts` documents under its
 * "no-passthrough rule". Under this walk a new upstream field fails closed
 * (enveloped — cosmetic), never open.
 *
 * A structural exemption needs BOTH halves:
 *
 * - the KEY names a value the model must quote verbatim into a follow-up tool
 *   call or a filter (ids, enum-like statuses/severities/types, ISO-8601
 *   dates, http(s) URLs, pagination cursors) — enveloping those would corrupt
 *   the round-trip; and
 * - the VALUE matches that context's strict grammar (id/enum alphabet with no
 *   `:`/`/`/whitespace, ISO-8601 timestamp, parseable http(s) URL, cursor
 *   alphabet) and is not instruction-shaped (`IGNORE_PRIOR_INSTRUCTIONS`
 *   satisfies the alphabet, so multi-word phrase shapes and instruction
 *   tokens lose the exemption too).
 *
 * A key name alone can never pass raw text through: prose under a
 * structural-looking key (`status: "ignore prior instructions"`) fails the
 * grammar and is enveloped. All grammars fail toward enveloping, never
 * toward raw passthrough — worst case a genuine but oddly-shaped structural
 * value gets enveloped, which is cosmetic.
 *
 * Strings under credential-shaped keys are replaced with `[redacted]`, not
 * enveloped: an envelope marks text as untrusted but still discloses it.
 */
import { wrapUntrusted } from './untrusted-content.js';

const REDACTED_CREDENTIAL_VALUE = '[redacted]';

/**
 * Ids, enum values and cursors never contain `:` or whitespace, and ids/enums
 * never contain `/`. The envelope's close tag needs `/` and instruction-
 * shaping leans on `:` and spaces; none belong in a structural value.
 */
const ID_OR_ENUM_VALUE_PATTERN = /^[A-Za-z0-9_+@.-]{1,128}$/;
const CURSOR_VALUE_PATTERN = /^[A-Za-z0-9_+/.=-]{1,2048}$/;
const ISO_8601_TIMESTAMP_VALUE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Instruction-shaping tokens, matched as whole separator-delimited words
 * (case-insensitive). Genuine ids are random and genuine enums are short
 * known words, so none of these appear in a legitimate structural value.
 * Defence in depth on top of the phrase-shape rule below — a denylist can
 * never enumerate every paraphrase, and it is not the boundary; the grammar
 * gate is.
 */
const INSTRUCTION_PHRASE_TOKENS: ReadonlySet<string> = new Set([
  'ignore', 'ignores', 'ignoring', 'ignored',
  'instruction', 'instructions', 'instruct', 'instructs',
  'previous', 'prior', 'earlier',
  'forget', 'forgot', 'disregard', 'override', 'bypass',
  'reveal', 'reveals', 'expose', 'exposes', 'exfiltrate', 'leak', 'leaks',
  'secret', 'secrets', 'credential', 'credentials', 'password', 'passwords',
  'jailbreak', 'prompt', 'prompts',
  'system', 'developer',
  'obey', 'comply',
]);

/**
 * Alphabet shape alone cannot separate an identifier from whitespace-free
 * authored instructions — `IGNORE_PRIOR_INSTRUCTIONS` satisfies the id/enum
 * alphabet. A multi-word value containing an instruction-shaping token never
 * occurs in a genuine id or enum and always reads as authored text, so it
 * loses the exemption. (Genuine single-word enums like `type: "system"` are
 * why the check only fires on multi-word values.)
 */
const hasInstructionToken = (value: string, separators: RegExp): boolean => {
  const segments = value.split(separators).filter((segment) => segment.length > 0);
  return (
    segments.length >= 2 &&
    segments.some((segment) => INSTRUCTION_PHRASE_TOKENS.has(segment.toLowerCase()))
  );
};

/**
 * Enum contexts additionally reject English-phrase shapes (three or more
 * all-letter words joined by separators): genuine enums are one word,
 * occasionally two (`IN_PROGRESS`). Id contexts deliberately do NOT apply
 * this rule — Vanta uses kebab-case word slugs as genuine, round-trippable
 * ids (`code-of-conduct-bsi`, `assets-not-identified-and-protected`), so the
 * phrase rule would envelope real ids and corrupt the get-by-id round-trip.
 */
const isLetterPhrase = (value: string, separators: RegExp): boolean => {
  const segments = value.split(separators).filter((segment) => segment.length > 0);
  return (
    segments.length >= 3 && segments.every((segment) => /^[A-Za-z]+$/.test(segment))
  );
};

const isIdShaped = (value: string): boolean =>
  ID_OR_ENUM_VALUE_PATTERN.test(value) && !hasInstructionToken(value, /[_+@.-]+/);

const isEnumShaped = (value: string): boolean =>
  isIdShaped(value) && !isLetterPhrase(value, /[_+@.-]+/);

const isCursorShaped = (value: string): boolean =>
  CURSOR_VALUE_PATTERN.test(value) && !hasInstructionToken(value, /[_+/.=@-]+/);

const isTimestampShaped = (value: string): boolean => ISO_8601_TIMESTAMP_VALUE_PATTERN.test(value);

const isHttpUrlShaped = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

// Enum-like keys whose values the model quotes back into filters and whose
// grammar is the id/enum alphabet. Broad on key suffix, strict on value
// shape: an odd genuine value fails closed (enveloped — cosmetic).
const ENUM_KEY_SUFFIXES = ['Status', 'Severity', 'State', 'Type', 'Level', 'Action', 'Kind', 'Format'];
const ENUM_EXACT_KEYS: ReadonlySet<string> = new Set([
  'status', 'severity', 'state', 'type', 'action', 'kind', 'format', 'level',
]);

const CURSOR_KEYS: ReadonlySet<string> = new Set(['cursor', 'endCursor', 'startCursor', 'nextCursor', 'pageCursor']);

const SENSITIVE_EXACT_KEYS: ReadonlySet<string> = new Set([
  'token', 'accessToken', 'refreshToken', 'idToken', 'clientSecret', 'secret', 'password',
  'authorization', 'apiKey', 'apikey', 'sessionToken',
]);

const isSensitiveKey = (key: string): boolean => {
  if (SENSITIVE_EXACT_KEYS.has(key)) return true;
  const lower = key.toLowerCase();
  return lower.endsWith('secret') || lower.endsWith('password') || lower.endsWith('token');
};

/**
 * A string keeps its literal exemption only when the key names a structural
 * value AND the value matches that context's grammar. Every grammar fails
 * toward enveloping.
 */
const isExemptStructuralValue = (key: string | undefined, value: string): boolean => {
  if (!key) return false;
  if (key === 'id' || key === 'uid' || key.endsWith('Id') || key.endsWith('ID')) {
    return isIdShaped(value);
  }
  if (CURSOR_KEYS.has(key)) return isCursorShaped(value);
  if (key.endsWith('At') || key.endsWith('Date')) return isTimestampShaped(value);
  if (key === 'url' || key.endsWith('Url') || key.endsWith('URL') || key === 'link' || key.endsWith('Link')) {
    return isHttpUrlShaped(value);
  }
  if (ENUM_EXACT_KEYS.has(key) || ENUM_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix))) {
    return isEnumShaped(value);
  }
  return false;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sanitizeValue = (value: unknown, key: string | undefined): unknown => {
  if (typeof value === 'string') {
    return isExemptStructuralValue(key, value)
      ? value
      : wrapUntrusted(value, key ? `vanta:${key}` : 'vanta');
  }
  if (Array.isArray(value)) {
    // String arrays inherit the parent key's source label and grammar gate;
    // object/array members re-key on their own entries.
    return value.map((item) => (typeof item === 'string' ? sanitizeValue(item, key) : sanitizeValue(item, undefined)));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        isSensitiveKey(childKey) && typeof childValue === 'string'
          ? REDACTED_CREDENTIAL_VALUE
          : sanitizeValue(childValue, childKey),
      ]),
    );
  }
  // Non-string primitives (number / boolean / null / undefined) carry no
  // injectable text.
  return value;
};

/**
 * Recursively envelope every string in API response data except grammar-
 * checked structural literals. Apply BEFORE assembling the tool payload so
 * connector-authored fields (ok, count, truncation_hint, …) are never
 * enveloped. No root shape passes through unchanged: a bare string root is
 * enveloped, arrays and objects are walked, and only non-string primitives
 * survive untouched.
 */
export function sanitizeExternalText<T>(value: T): T {
  return sanitizeValue(value, undefined) as T;
}
