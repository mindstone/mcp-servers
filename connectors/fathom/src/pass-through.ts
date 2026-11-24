/**
 * Output rules for the Fathom values the tools pass through (invariant #6).
 *
 * A known metadata field stays raw only when its value has the shape that
 * field should have; anything else Fathom sends is enveloped as untrusted
 * content. Numbers, booleans and null are never changed.
 */

import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

export type MetadataKind = 'id' | 'time' | 'url' | 'email' | 'domain' | 'enum' | 'mime' | 'token' | 'flag' | 'number';

// `caller`: the tool sets this field itself, with its own source label.
export type Policy = Record<string, MetadataKind | 'caller'>;

// A date, a date-time (optional fraction and zone), or a time of day (`00:10:45`).
const TIME = /^(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)$/;
const DOMAIN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;
// Plain ASCII only: zero-width and other invisible characters are not \s.
const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isUrl(value: string): boolean {
  // Printable ASCII only, and no `<`, `>` or `"`: those parse inside a URL path
  // but could carry an envelope tag, and invisible characters could hide text.
  if (/[^\x21-\x7e]|[<>"]/.test(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const SHAPES: Record<MetadataKind, (value: unknown) => boolean> = {
  id: (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v)),
  time: (v) => typeof v === 'string' && TIME.test(v),
  url: (v) => typeof v === 'string' && isUrl(v),
  email: (v) => typeof v === 'string' && v.length <= 254 && EMAIL.test(v),
  domain: (v) => typeof v === 'string' && v.length <= 253 && DOMAIN.test(v),
  enum: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v), // `en-US` too
  mime: (v) => typeof v === 'string' && /^[a-z0-9.+/-]{1,100}$/.test(v),
  // A secret or signing token (base64, hex or prefixed): no spaces, no tag characters.
  token: (v) => typeof v === 'string' && /^[A-Za-z0-9_.:+/=-]{1,512}$/.test(v),
  flag: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
};

/** `value` unchanged when it has the shape `kind` expects (or is null/undefined), else enveloped. */
export function metadata(value: unknown, kind: MetadataKind, source: string): unknown {
  if (value === null || value === undefined || SHAPES[kind](value)) return value;
  return wrapUntrustedJsonStrings(value, source);
}

// An own property even for `__proto__`, which plain assignment would swallow.
function define(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Copy a Fathom record for output. Fields in `policy` go through `metadata`
 * (source `<record>:<field>`); `caller` fields are left out for the tool to
 * set. Every other field is enveloped whole (source `<record>:extension`),
 * and its key too unless it is a plain identifier.
 */
export function wrapPassThrough(obj: object, policy: Policy, record: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const extension = `${record}:extension`;
  for (const [key, value] of Object.entries(obj)) {
    const kind = Object.hasOwn(policy, key) ? policy[key] : undefined;
    if (kind === 'caller') continue;
    if (kind) {
      define(out, key, metadata(value, kind, `${record}:${key}`));
    } else {
      const outKey = PLAIN_KEY.test(key) ? key : (wrapUntrusted(key, extension) ?? key);
      define(out, outKey, wrapUntrustedJsonStrings(value, extension));
    }
  }
  return out;
}
