/**
 * AGENTS.md security invariant #6 — content fetched from an external system
 * MUST be wrapped in an `<untrusted-content source="…">…</untrusted-content>`
 * envelope (with close-tag breakout escaping) before it is returned to the
 * LLM, so the model treats third-party / attacker-controllable text as DATA,
 * not as instructions.
 *
 * This is a VENDORED copy of the shared canonical reference in
 * `test-harness/src/untrusted-content.ts` — connectors cannot `import` the
 * test-harness at runtime (it is a test/dev-only `file:` dependency that is
 * never published into a connector's `dist/`), so the helper lives in the
 * connector's own runtime source. Keep the implementation below byte-for-byte
 * in sync with the shared reference; do NOT weaken the escaping back to a
 * simple `replaceAll` (that family misses whitespace / case close-tag
 * variants like `</untrusted-content >` / `</UNTRUSTED-CONTENT>`).
 *
 * `scripts/check-untrusted-coverage.mjs` greps for a reference to
 * `untrusted-content` in any connector that talks to an external system; this
 * file (and the call sites that import from it) is what satisfies that gate.
 */

const UNTRUSTED_CLOSE_TAG_VARIANT = /<\/untrusted-content\s*>/gi;
const ESCAPED_UNTRUSTED_CLOSE_TAG = '<\\/untrusted-content>';
const UNTRUSTED_ENVELOPE = /^<untrusted-content source="[^"]*">([\s\S]*)<\/untrusted-content>$/;

function escapeAttr(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Rewrite every `</untrusted-content>` variant (case-insensitive, optional
 * whitespace before `>`) inside `s` to a benign textual form, so an attacker
 * who controls the wrapped content cannot terminate the envelope early.
 */
function escapeCloseTagSentinels(s: string): string {
  return s.replace(UNTRUSTED_CLOSE_TAG_VARIANT, ESCAPED_UNTRUSTED_CLOSE_TAG);
}

function unescapeCloseTagSentinels(s: string): string {
  return s.replaceAll(ESCAPED_UNTRUSTED_CLOSE_TAG, '</untrusted-content>');
}

/**
 * Wrap a single untrusted string in an `<untrusted-content source="…">`
 * envelope, escaping any embedded close-tag variant so the envelope cannot be
 * broken out of.
 *
 * `undefined` is passed through untouched so callers can apply the wrapper
 * uniformly to optional fields without branching.
 *
 * Idempotent: when `text` is already a properly-shaped envelope for the SAME
 * `source` (starts with the matching OPEN tag, ends with CLOSE, and contains no
 * internal close-tag variants), the original string is returned unchanged so
 * `wrapUntrusted(wrapUntrusted(s, src), src) === wrapUntrusted(s, src)`.
 */
export function wrapUntrusted(text: string | null | undefined, source: string): string | undefined {
  if (text === undefined || text === null) return undefined;
  const open = `<untrusted-content source="${escapeAttr(source)}">`;
  const close = '</untrusted-content>';
  if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
    const inner = text.slice(open.length, text.length - close.length);
    if (!UNTRUSTED_CLOSE_TAG_VARIANT.test(inner)) {
      UNTRUSTED_CLOSE_TAG_VARIANT.lastIndex = 0; // reset stateful /g regex
      return text;
    }
    UNTRUSTED_CLOSE_TAG_VARIANT.lastIndex = 0;
  }
  return `${open}${escapeCloseTagSentinels(text)}${close}`;
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
  return unescapeCloseTagSentinels(match[1]);
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
