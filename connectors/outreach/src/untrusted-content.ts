/**
 * The `<untrusted-content source="…">` envelope (AGENTS.md security invariant #6):
 * third-party text reaches the model as data, with embedded tags escaped (best
 * effort against breakout, not a full sanitiser). This is the one maintained copy,
 * tested in test-harness/test/untrusted-content.test.ts; connectors vendor it
 * unchanged and scripts/check-untrusted-coverage.mjs fails CI on any difference.
 */

// Matches the `<` + tag-name prefix only (case-insensitive, ended by whitespace, `/`
// or `>`), so it stays linear and attributes cannot evade it. Escaping adds one `\`
// after the `<`, so unwrapping restores the text exactly.
const UNTRUSTED_TAG_PREFIX = /<(\\*)(\/?untrusted-content)(?=[\s/>])/gi;
const ESCAPED_UNTRUSTED_TAG_PREFIX = /<\\(\\*)(\/?untrusted-content)(?=[\s/>])/gi;
const RAW_UNTRUSTED_TAG_PREFIX = /<\/?untrusted-content(?=[\s/>])/i;
const UNTRUSTED_ENVELOPE = /^<untrusted-content source="[^"]*">([\s\S]*)<\/untrusted-content>$/;

function escapeAttr(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Escape every open or close untrusted-content tag in `s`, without an envelope. */
export function escapeUntrustedTags(s: string): string {
  return s.replace(UNTRUSTED_TAG_PREFIX, '<\\$1$2');
}

function unescapeTagSentinels(s: string): string {
  return s.replace(ESCAPED_UNTRUSTED_TAG_PREFIX, '<$1$2');
}

/**
 * Wrap `text` in an envelope, escaping embedded tags. `null`/`undefined` give
 * `undefined`; an existing clean envelope for the same source is returned as is.
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
  return `${open}${escapeUntrustedTags(text)}${close}`;
}

/** Strip one envelope and its escaping from `text`; other text is returned unchanged. */
export function unwrapUntrusted(text: string): string {
  const match = UNTRUSTED_ENVELOPE.exec(text);
  if (!match) return text;
  return unescapeTagSentinels(match[1]);
}

/** Recursively wrap every string key and value in `value`; other leaves pass through. */
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

/** Like `wrapUntrustedJsonStrings`, but keys stay as they are (for the connector's own field names). */
export function wrapUntrustedJsonValues<T>(value: T, source: string): T {
  if (typeof value === 'string') {
    return wrapUntrusted(value, source) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => wrapUntrustedJsonValues(item, source)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, wrapUntrustedJsonValues(item, source)]),
    ) as T;
  }
  return value;
}

/** Recursively unwrap every string key and value in `value`. */
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
