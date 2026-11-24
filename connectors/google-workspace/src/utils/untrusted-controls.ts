/**
 * Google Workspace's own envelope helpers, built on the vendored canonical
 * helper in ./untrusted-content.ts (which must stay byte-identical to
 * test-harness/src/untrusted-content.ts, so connector-specific code lives here).
 */
import { wrapUntrusted } from './untrusted-content.js';

/**
 * Wrap external text, except provider-generated controls at declared response
 * paths. A `*` segment matches array items only; `{}` explicitly matches the
 * values of an object map at that path, without exempting other map content.
 * Declare only ids an outsider cannot choose. Ids an author or sender can pick
 * (Calendar event ids, calendar addresses, Docs tab ids, Slides object ids) stay
 * wrapped, as do headers, titles and metadata; the server strips the envelope
 * from id arguments (`unwrapIdArgs`), so a wrapped id still works when passed back.
 */
export function wrapUntrustedJsonControls<T>(value: T, source: string, controlPaths: readonly string[]): T {
  const paths = controlPaths.map(path => ({ segments: path.split('.'), shape: /^[A-Za-z0-9_+/=.~!\-]+$/ }));
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
