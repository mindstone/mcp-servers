import { isRecord } from './api-catalog.js';
import { escapeUntrustedTags } from './untrusted-content.js';

/** Collect string operands before validation; diagnostics may echo them as dictionary keys. */
export function sensitiveValues(value: unknown, paths: readonly (readonly string[])[]): string[] {
  const values = new Set<string>();
  function visit(item: unknown, path: readonly string[]): void {
    if (!path.length) {
      // Object alternatives at a leaf are references, not credential values.
      if (typeof item === 'string' && item.length) values.add(item);
      return;
    }
    const [field, ...rest] = path;
    if (field === '*' && (isRecord(item) || Array.isArray(item))) Object.values(item).forEach(child => visit(child, rest));
    else if (isRecord(item) && Object.hasOwn(item, field)) visit(item[field], rest);
  }
  paths.forEach(path => visit(value, path));
  return [...values];
}

/**
 * Replace string leaves at declared paths only; their values are workspace data, not something the caller submitted.
 * A stored value the provider repeats outside its declared path is not caught, because replacing short stored values
 * everywhere damaged IDs, URLs and policies. Non-string leaves (a numeric meta value) are left as they are.
 */
export function redactAtPaths(value: unknown, paths: readonly (readonly string[])[]): unknown {
  function visit(item: unknown, path: readonly string[]): unknown {
    if (!path.length) return typeof item === 'string' && item.length ? '[REDACTED]' : item;
    const [field, ...rest] = path;
    if (field === '*' && Array.isArray(item)) return item.map(child => visit(child, rest));
    if (field === '*' && isRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, rest)]));
    if (isRecord(item) && Object.hasOwn(item, field)) return { ...item, [field]: visit(item[field], rest) };
    return item;
  }
  return paths.reduce<unknown>((result, path) => visit(result, path), value);
}

function uriSpelling(value: string): string {
  try { return encodeURIComponent(value); } catch { return value; }
}

/** The API key and submitted credentials share one redaction path, including JSON keys. */
export function redactSensitive(value: unknown, secrets: readonly string[]): unknown {
  const spellings = [...new Set(secrets.filter(Boolean).flatMap(secret => [
    secret, uriSpelling(secret), JSON.stringify(secret).slice(1, -1), escapeUntrustedTags(secret),
    JSON.stringify(escapeUntrustedTags(secret)).slice(1, -1),
  ]))].sort((a, b) => b.length - a.length);
  const text = (input: string) => spellings.reduce((result, secret) => result.split(secret).join('[REDACTED]'), input);
  function scrub(item: unknown): unknown {
    if (typeof item === 'string') return text(item);
    if (Array.isArray(item)) return item.map(scrub);
    if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [text(key), scrub(child)]));
    return item;
  }
  return scrub(value);
}
