/**
 * AGENTS.md security invariant #6 — content fetched from an external system
 * MUST be wrapped in an `<untrusted-content source="…">…</untrusted-content>`
 * envelope (with close-tag breakout escaping) before it is returned to the
 * LLM, so the model treats third-party / attacker-controllable text as DATA,
 * not as instructions.
 *
 * This is the canonical implementation a new connector ships with. It is a
 * VENDORED copy of the shared reference in `test-harness/src/untrusted-content.ts`
 * — connectors cannot `import` the test-harness at runtime (it is a
 * test/dev-only `file:` dependency that is never published into a connector's
 * `dist/`), so the helper lives in the connector's own runtime source. Keep
 * this byte-for-byte in sync with the shared reference; do NOT weaken the
 * escaping back to a simple `replaceAll` (that family misses whitespace / case
 * close-tag variants like `</untrusted-content >` / `</UNTRUSTED-CONTENT>`).
 *
 * `scripts/check-untrusted-coverage.mjs` greps for a reference to
 * `untrusted-content` in any connector that talks to an external system; this
 * file (and the call sites that import from it) is what satisfies that gate.
 */

const UNTRUSTED_CLOSE_TAG_VARIANT = /<\/untrusted-content\s*>/gi;
const ESCAPED_UNTRUSTED_CLOSE_TAG = '<\\/untrusted-content>';

function escapeAttr(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeCloseTagSentinels(s: string): string {
  return s.replace(UNTRUSTED_CLOSE_TAG_VARIANT, ESCAPED_UNTRUSTED_CLOSE_TAG);
}

/**
 * Wrap a single untrusted string in an `<untrusted-content source="…">`
 * envelope, escaping any embedded close-tag variant so the envelope cannot be
 * broken out of. `undefined` passes through untouched. Idempotent for the same
 * `source`.
 */
export function wrapUntrusted(text: string | null | undefined, source: string): string | undefined {
  if (text === undefined || text === null) return undefined;
  const open = `<untrusted-content source="${escapeAttr(source)}">`;
  const close = '</untrusted-content>';
  if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
    const inner = text.slice(open.length, text.length - close.length);
    if (!UNTRUSTED_CLOSE_TAG_VARIANT.test(inner)) {
      UNTRUSTED_CLOSE_TAG_VARIANT.lastIndex = 0;
      return text;
    }
    UNTRUSTED_CLOSE_TAG_VARIANT.lastIndex = 0;
  }
  return `${open}${escapeCloseTagSentinels(text)}${close}`;
}

/**
 * Recursively wrap every string value reachable inside `value`. Object keys are
 * structural and NOT wrapped; non-string leaves pass through unchanged.
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
      Object.entries(value).map(([key, item]) => [key, wrapUntrustedJsonStrings(item, source)])
    ) as T;
  }
  return value;
}

/**
 * Wrap external text, except provider-generated controls at declared response
 * paths. A `*` segment matches array items only; `{}` explicitly matches the
 * values of an object map at that path, without exempting other map content.
 * Calendar event ids use separate declared paths with Google's base32hex and
 * recurring-instance shape check. Other author-chosen ids (e.g. Slides object
 * ids), headers, titles, and metadata must not be declared as controls.
 */
export function wrapUntrustedJsonControls<T>(
  value: T, source: string, controlPaths: readonly string[], eventIdPaths: readonly string[] = [],
  calendarIdPaths: readonly string[] = [],
): T {
  const paths = [
    ...controlPaths.map(path => ({ segments: path.split('.'), shape: /^[A-Za-z0-9_+/=.~!\-]+$/ })),
    ...eventIdPaths.map(path => ({ segments: path.split('.'), shape: /^[a-v0-9]{5,1024}(?:_R[0-9]{8}T[0-9]{6})?(?:_[0-9]{8}(?:T[0-9]{6}Z)?)?$/ })),
    // Calendar-list ids are provider-issued addresses, including public holiday calendars.
    ...calendarIdPaths.map(path => ({ segments: path.split('.'), shape: /^[A-Za-z0-9_.+%#=\-]+@[A-Za-z0-9.\-]+$/ })),
  ];
  function visit(item: unknown, remaining: typeof paths): unknown {
    if (typeof item === 'string') {
      // Compare the full match because JavaScript's $ also accepts a trailing newline.
      return remaining.some(path => path.segments.length === 0 && path.shape.exec(item)?.[0] === item)
        ? item : wrapUntrusted(item, source);
    }
    if (Array.isArray(item)) {
      const children = remaining.filter(path => path.segments[0] === '*')
        .map(path => ({ ...path, segments: path.segments.slice(1) }));
      return item.map(child => visit(child, children));
    }
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
        visit(child, remaining.filter(path => path.segments[0] === '{}' ||
          (path.segments[0] !== '*' && path.segments[0] === key))
          .map(path => ({ ...path, segments: path.segments.slice(1) }))),
      ]));
    }
    return item;
  }
  return visit(value, paths) as T;
}

/**
 * Connector-local alias for `wrapUntrusted` under the name the existing call
 * sites were written against. `content` is required (never `undefined`), so
 * the result is always a string.
 */
export function wrapUntrustedContent(content: string, source: string): string {
  // wrapUntrusted returns undefined only for undefined input.
  return wrapUntrusted(content, source)!;
}
