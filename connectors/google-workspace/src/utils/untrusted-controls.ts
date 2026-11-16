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
