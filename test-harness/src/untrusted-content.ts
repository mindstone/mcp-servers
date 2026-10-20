/**
 * Shared `<untrusted-content>` envelope helper.
 *
 * AGENTS.md security invariant #6: content fetched from external systems MUST
 * be wrapped in `<untrusted-content source="…">…</untrusted-content>` envelopes
 * — with close-tag breakout escaping — before it is returned to the LLM, so the
 * model treats third-party / attacker-controllable text as DATA, not as
 * instructions.
 *
 * This module is the single canonical home for the envelope helper. Historically
 * each connector carried its own copy and they DRIFTED into two families:
 *
 *   - a weak `replaceAll('</untrusted-content>', …)` family (slack,
 *     google-workspace, replit-ssh carried it — all migrated 2026-08-05) that
 *     misses whitespace / case close-tag variants such as
 *     `</untrusted-content >` or `</UNTRUSTED-CONTENT>`; and
 *   - a stronger regex family (freshdesk, zendesk, email-imap) that is
 *     idempotent and neutralises every case/whitespace variant of the close
 *     tag.
 *
 * This helper adopts the STRONGER family, extended (2026-08-09) to also
 * neutralise attribute-bearing close-tag variants (`</untrusted-content foo>`)
 * and spoofed OPEN tags (`<untrusted-content source="evil">`) inside wrapped
 * content — an LLM parsing the markup plausibly accepts both as envelope
 * boundaries. The 2026-08-05 hardening program
 * migrated every connector onto this canonical implementation (or a
 * byte-for-byte vendored copy of it).
 *
 * It also lives in `test-harness/` (already a `file:`-linked dependency of every
 * connector) specifically so a grep / import audit — and the
 * `scripts/check-untrusted-coverage.mjs` gate — can verify that every
 * external-text boundary reaches it.
 */

// Only the `<` + tag-name prefix is matched. Whitespace, `/` or `>` after the
// name ends it, so `</untrusted-content/>` and `<untrusted-content/source="x">`
// read as tags too; the rest of the tag is left as text. Matching never scans
// ahead for a `>`, so it stays linear on hostile input and nothing in the
// attributes can evade it. Escaping inserts one `\` after the `<`
// (`<\untrusted-content`, `<\/untrusted-content`); a prefix that already
// carries backslashes gains one more, so unwrapping restores the text exactly.
const UNTRUSTED_TAG_PREFIX = /<(\\*)(\/?untrusted-content)(?=[\s/>])/gi;
const ESCAPED_UNTRUSTED_TAG_PREFIX = /<\\(\\*)(\/?untrusted-content)(?=[\s/>])/gi;
const RAW_UNTRUSTED_TAG_PREFIX = /<\/?untrusted-content(?=[\s/>])/i;
const UNTRUSTED_ENVELOPE = /^<untrusted-content source="[^"]*">([\s\S]*)<\/untrusted-content>$/;

function escapeAttr(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Neutralise every `</untrusted-content …>` and `<untrusted-content …>` variant
 * (case-insensitive; whitespace, `/`, attributes or `>` after the name) inside
 * `s` by escaping its tag-name prefix, so an attacker who controls the wrapped
 * content can neither terminate the envelope early nor spoof a nested open tag
 * that a downstream parser could re-read as a fresh envelope. An LLM parsing
 * the markup plausibly accepts attribute-bearing close forms such as
 * `</untrusted-content foo>` — escaping the prefix covers them whatever follows.
 */
function escapeTagSentinels(s: string): string {
  return s.replace(UNTRUSTED_TAG_PREFIX, '<\\$1$2');
}

function unescapeTagSentinels(s: string): string {
  return s.replace(ESCAPED_UNTRUSTED_TAG_PREFIX, '<$1$2');
}

/**
 * Wrap a single untrusted string in an `<untrusted-content source="…">`
 * envelope, escaping any embedded open/close-tag variant so the envelope can
 * neither be broken out of nor have a spoofed nested envelope planted inside.
 *
 * `undefined` and `null` are passed through untouched so callers can apply the wrapper
 * uniformly to optional fields without branching.
 *
 * Idempotent: when `text` is already a properly-shaped envelope for the SAME
 * `source` (starts with the matching OPEN tag, ends with CLOSE, and contains no
 * internal open/close-tag variants), the original string is returned unchanged so
 * `wrapUntrusted(wrapUntrusted(s, src), src) === wrapUntrusted(s, src)`.
 */
export function wrapUntrusted(text: string | null | undefined, source: string): string | undefined {
  if (text === undefined || text === null) return undefined;
  const open = `<untrusted-content source="${escapeAttr(source)}">`;
  const close = '</untrusted-content>';
  if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
    const inner = text.slice(open.length, text.length - close.length);
    if (!RAW_UNTRUSTED_TAG_PREFIX.test(inner)) {
      return text;
    }
  }
  return `${open}${escapeTagSentinels(text)}${close}`;
}

/**
 * Strip one `<untrusted-content>` envelope from `text` if present, returning raw
 * strings unchanged. This is intentionally one-layer and idempotent for already
 * raw input so callers can accept either displayed wrapped content or manually
 * authored content.
 */
export function unwrapUntrusted(text: string): string {
  const match = UNTRUSTED_ENVELOPE.exec(text);
  if (!match) return text;
  return unescapeTagSentinels(match[1]);
}

/**
 * Recursively wrap every string key and value reachable inside `value` (strings,
 * arrays, plain-object property keys and values) in an `<untrusted-content>` envelope.
 *
 * Use this when a whole response blob is third-party data and you want to
 * envelope it wholesale rather than enumerate fields. Non-string leaves (numbers,
 * booleans, null) pass through unchanged.
 */
export function wrapUntrustedJsonStrings<T>(value: T, source: string): T {
  if (typeof value === 'string') {
    return wrapUntrusted(value, source) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => wrapUntrustedJsonStrings(item, source)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        wrapUntrusted(key, source) ?? key,
        wrapUntrustedJsonStrings(item, source),
      ]),
    ) as T;
  }
  return value;
}

/**
 * Recursively unwrap every string key and value reachable inside `value`.
 * Non-string leaves pass through unchanged.
 */
export function unwrapUntrustedJsonStrings<T>(value: T): T {
  if (typeof value === 'string') {
    return unwrapUntrusted(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => unwrapUntrustedJsonStrings(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        unwrapUntrusted(key),
        unwrapUntrustedJsonStrings(item),
      ]),
    ) as T;
  }
  return value;
}
