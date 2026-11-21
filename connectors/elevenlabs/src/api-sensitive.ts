import { matchesFieldPath } from './api-field-paths.mjs';
import { isRecord } from './api-catalog.js';
import { credentialIdentifiers, isCredentialKey } from './api-credential-keys.mjs';
import { escapeUntrustedTags, wrapUntrusted } from './untrusted-content.js';

type SubmittedSecret = string | number | boolean;
export type ReferenceGuard = (root: unknown, path: readonly string[]) => boolean;

/** Collect before validation, including credential keys in arbitrary open objects. */
export function sensitiveValues(value: unknown, paths: readonly (readonly string[])[], reference?: ReferenceGuard): SubmittedSecret[] {
  const values = new Set<SubmittedSecret>();
  function scalar(item: unknown): void {
    if ((typeof item === 'string' && item.length) || typeof item === 'number' || typeof item === 'boolean') values.add(item);
  }
  function visit(item: unknown, path: readonly string[], concrete: string[] = []): void {
    if (reference?.(value, concrete)) return;
    if (!path.length) {
      // Object alternatives at a declared leaf can be references, not credentials.
      scalar(item);
      return;
    }
    const [field, ...rest] = path;
    if (field === '*' && (isRecord(item) || Array.isArray(item))) Object.entries(item).forEach(([key, child]) => visit(child, rest, [...concrete, key]));
    else if (isRecord(item) && Object.hasOwn(item, field)) visit(item[field], rest, [...concrete, field]);
  }
  function openObjects(item: unknown, sensitive = false, entries = false, concrete: string[] = []): void {
    if (reference?.(value, concrete)) return;
    if (Array.isArray(item)) item.forEach((child, index) => openObjects(child, sensitive, false, [...concrete, String(index)]));
    else if (isRecord(item)) for (const [key, child] of Object.entries(item)) {
      // Locators identify an existing secret; they are not its value.
      if (entries || !credentialIdentifiers.has(key) || isRecord(child) || Array.isArray(child)) {
        openObjects(child, sensitive || isCredentialKey(key), /^(request_headers|request_meta)$/i.test(key), [...concrete, key]);
      }
    }
    else if (sensitive) scalar(item);
  }
  paths.forEach(path => visit(value, path));
  openObjects(value);
  return [...values];
}

/** Stored credentials are hidden only at declared paths, preserving unrelated workspace data. */
export function redactAtPaths(value: unknown, paths: readonly (readonly string[])[], reference?: ReferenceGuard): unknown {
  function visit(item: unknown, path: readonly string[], concrete: string[] = []): unknown {
    if (reference?.(value, concrete)) return item;
    if (!path.length) return item === null || item === undefined ? item : '[REDACTED]';
    const [field, ...rest] = path;
    if (field === '*' && Array.isArray(item)) return item.map((child, index) => visit(child, rest, [...concrete, String(index)]));
    if (field === '*' && isRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, rest, [...concrete, key])]));
    if (isRecord(item) && Object.hasOwn(item, field)) return { ...item, [field]: visit(item[field], rest, [...concrete, field]) };
    return item;
  }
  return paths.reduce<unknown>((result, path) => visit(result, path), value);
}

function uriSpelling(value: string): string {
  try { return encodeURIComponent(value); } catch { return value; }
}
const regexEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Redactor {
  include(value: string): void;
  redact(value: unknown, response?: ResponseRedaction): unknown;
  text(value: string): string;
  wrap(value: string, source: string): string;
}

interface ResponseRedaction {
  sensitive_response_fields?: readonly (readonly string[])[];
  credential_return_fields?: readonly (readonly string[])[];
  reference?: ReferenceGuard;
  credentialReturn?: ReferenceGuard;
}

/**
 * Replaces each complete JSON-style quoted literal, reading every character once.
 * An unterminated literal ends the scan: no later quote can close one, because it
 * would read the remaining text in the same escape phase.
 */
function replaceQuotedLiterals(input: string, replace: (literal: string) => string): string {
  let output = '';
  let copied = 0;
  for (let start = input.indexOf('"'); start !== -1; start = input.indexOf('"', copied)) {
    let end = start + 1;
    while (end < input.length && input[end] !== '"') end += input[end] === '\\' ? 2 : 1;
    if (end >= input.length) break;
    output += input.slice(copied, start) + replace(input.slice(start, end + 1));
    copied = end + 1;
  }
  return copied === 0 ? input : output + input.slice(copied);
}

/** Layers of JSON encoding decoded before matching; deeper echoes are matched only as they appear. */
const MAX_DECODE_DEPTH = 16;

/** The secrets stay in this closure; every output uses the same type-independent matcher. */
export function createRedactor(secrets: readonly SubmittedSecret[]): Redactor {
  function redact(value: unknown, response?: ResponseRedaction): unknown {
    if (response) {
      value = redactAtPaths(value, response.sensitive_response_fields ?? [], response.reference);
      if (response.credential_return_fields) {
        const returns = response.credential_return_fields;
        // The mask applies to parsed response keys, not JSON documents embedded in strings; only the submitted-secret and API-key matcher applies there.
        function mask(item: unknown, path: string[], sensitive = false): unknown {
          if (response?.reference?.(value, path)) return item;
          if (Array.isArray(item)) return item.map((child, index) => mask(child, [...path, String(index)], sensitive));
          if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => {
            const childPath = [...path, key];
            const returnContainer = returns.some(declared => declared.length > childPath.length && childPath.every((part, index) => declared[index] === '*' || declared[index] === part));
            return [key, mask(child, childPath, sensitive || ((isCredentialKey(key) || key === 'signed_url') && !returnContainer))];
          }));
          const issued = returns.some(declared => matchesFieldPath(declared, path) && (!declared.includes('**') || response?.credentialReturn?.(value, path)));
          return sensitive && !issued && ['string', 'number', 'boolean'].includes(typeof item) ? '[REDACTED]' : item;
        }
        // Only actual response paths bypass credential-key masking. Submitted-secret matching below
        // still applies everywhere, including issued values that equal (or contain) a submitted secret.
        value = mask(value, []);
      }
    }
    const patterns = new Set<string>();
    for (const secret of secrets) {
      const raw = String(secret);
      if (!raw) continue;
      const uri = uriSpelling(raw);
      for (const base of new Set([raw, escapeUntrustedTags(raw), uri])) {
        let pattern = regexEscape(base).replace(/%[0-9a-f]{2}/gi,
          escape => escape.replace(/[a-f]/gi, letter => `[${letter.toLowerCase()}${letter.toUpperCase()}]`));
        if (base === uri) {
          const formEscapes: Record<string, string> = { '!': '%21', "'": '%27', '\\(': '%28', '\\)': '%29', '~': '%7[eE]' };
          pattern = pattern.replace(/%20|!|'|\\\(|\\\)|~/g, character => character === '%20'
            ? '(?: |%20|\\+)' : `(?:${character}|${formEscapes[character]})`);
        }
        // Scalars and short strings match whole tokens, preserving larger words and decimals.
        if (typeof secret !== 'string' || secret.length < 8 || /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) pattern = `(?<![\\p{L}\\p{N}_]|\\d\\.)${pattern}(?![\\p{L}\\p{N}_]|\\.\\d)`;
        patterns.add(pattern);
      }
    }
    const pattern = patterns.size ? new RegExp([...patterns].sort((a, b) => b.length - a.length).join('|'), 'gu') : undefined;
    // Each (layer, depth) pair is decoded and scrubbed once per call, so nested encodings cost linear work.
    const memo = new Map<string, string>();
    function text(input: string, depth = MAX_DECODE_DEPTH): string {
      if (!pattern) return input;
      const key = `${depth}:${input}`;
      const known = memo.get(key);
      if (known !== undefined) return known;
      const result = decodeAndMatch(input, depth);
      memo.set(key, result);
      return result;
    }
    function decodeAndMatch(input: string, depth: number): string {
      function document(literal: string): string {
        if (depth <= 0) return literal;
        let parsed: unknown;
        try { parsed = JSON.parse(literal); } catch { return literal; }
        const clean = scrub(parsed, depth - 1);
        return JSON.stringify(clean) !== JSON.stringify(parsed) ? JSON.stringify(clean) : literal;
      }
      if (/^\s*["{[]/.test(input)) {
        const clean = document(input);
        if (clean !== input) return clean;
      }
      // Quoted literals are scrubbed in place; the text around them still goes through every step below.
      const current = replaceQuotedLiterals(input, document);
      // Also accept isolated JSON string content without its enclosing quotes.
      // Unchanged strings retain their exact bytes.
      const decoded = current.replace(/\\(?:u[\da-fA-F]{4}|["\\/bfnrt])/g, escape => JSON.parse(`"${escape}"`) as string);
      if (depth > 0 && decoded.length < current.length) {
        const clean = text(decoded, depth - 1);
        if (clean !== decoded) return clean;
      }
      return current.replace(pattern!, '[REDACTED]');
    }
    function scrub(item: unknown, depth = MAX_DECODE_DEPTH): unknown {
      if (typeof item === 'string') return text(item, depth);
      if (typeof item === 'number' || typeof item === 'boolean') return text(String(item), depth) === String(item) ? item : '[REDACTED]';
      if (Array.isArray(item)) return item.map(child => scrub(child, depth));
      if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [text(key, depth), scrub(child, depth)]));
      return item;
    }
    return scrub(value);
  }
  const text = (value: string) => String(redact(value));
  return { include: value => { secrets = [...secrets, value]; }, redact, text, wrap: (value, source) => wrapUntrusted(text(value), source)! };
}
