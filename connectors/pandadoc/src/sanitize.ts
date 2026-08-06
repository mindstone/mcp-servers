/**
 * Envelope-wrapping for every external-text field PandaDoc returns to the LLM.
 *
 * Document and template names, recipient data, field/token definitions,
 * metadata, tags, folder names, contacts, and content-library entries are all
 * authored inside the PandaDoc workspace — potentially by third parties via
 * shared templates or sent documents — so they are attacker-controllable text
 * and MUST be enveloped before reaching the model (AGENTS.md security
 * invariant #6). This module is the single, auditable place that enumerates
 * each such field and reaches `wrapUntrusted` / `wrapUntrustedJsonStrings`.
 *
 * Identifiers and URLs are structural: downstream tool calls reference them
 * verbatim (`recipients[].id`, `fields[].uuid`, `contacts[].id`, …), and URLs
 * are surfaced for the user to open — not auto-followed. String values under
 * the keys in the structural sets are therefore left raw ONLY while they
 * still match the strict shape of what the key claims to be — and this
 * applies on EVERY output path, including the compact list/status
 * projections whose top-level `id`/`uuid` is the value downstream tools
 * reference:
 *
 *   - Identifiers: UUID, dense alphanumeric token (8–64 chars), or short
 *     dash/dot/underscore/tilde-separated segments (≤8 chars each) — the
 *     shapes real PandaDoc ids take. A natural-language phrase such as
 *     `SYSTEM-ignore-all-previous-instructions` does NOT match and is
 *     enveloped. (No charset can perfectly separate ids from prose: a
 *     separator-free instruction phrase, or an imperative built from words
 *     of ≤8 chars, would still pass — this is a fail-toward-envelope
 *     heuristic, not a boundary.)
 *   - URLs: only `https:` URLs on PandaDoc-owned hosts stay raw (session and
 *     shared links the user is expected to open). Any other URL — however
 *     well-formed — is enveloped, because instruction-like path/query text
 *     is indistinguishable from a legitimate URL string.
 *
 * Dates, status enums, counts, and booleans are passed through unchanged.
 */
import { wrapUntrusted } from './untrusted-content.js';

type Obj = Record<string, unknown>;

/**
 * Keys whose string values are expected to be identifiers rather than prose.
 * Kept raw so enveloped output stays machine-usable — but only while the
 * value actually matches one of the strict identifier shapes.
 */
const IDENTIFIER_KEYS = new Set([
  'id',
  'uuid',
  'folder_uuid',
  'parent_uuid',
  'entity_id',
]);

/**
 * Keys whose string values are expected to be URLs. Kept raw so the user can
 * open them — but only for https URLs on PandaDoc-owned hosts.
 */
const URL_KEYS = new Set(['url', 'href', 'shared_link', 'avatar']);

/** UUID (8-4-4-4-12 hex), e.g. folder_uuid / parent_uuid values. */
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Dense alphanumeric token, e.g. the 22-char document/contact ids. */
const DENSE_TOKEN_PATTERN = /^[A-Za-z0-9]{8,64}$/;
/** Short separator-joined segments (`doc-1`, `rcpt-1`, `entity_42`); no segment long enough to carry a wordy phrase. */
const SEGMENTED_ID_PATTERN = /^[A-Za-z0-9]{1,8}(?:[._~-][A-Za-z0-9]{1,8}){0,7}$/;

export function isSafeIdentifier(value: string): boolean {
  if (value.length > 64) return false;
  return (
    UUID_PATTERN.test(value) ||
    DENSE_TOKEN_PATTERN.test(value) ||
    SEGMENTED_ID_PATTERN.test(value)
  );
}

function isSafeUrl(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'pandadoc.com' || host.endsWith('.pandadoc.com');
  } catch {
    return false;
  }
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function wrapStr(v: unknown, source: string): unknown {
  return typeof v === 'string' ? wrapUntrusted(v, source) : v;
}

/**
 * Like `wrapUntrustedJsonStrings`, but string values under structural keys
 * (identifiers, URLs) pass through unchanged ONLY when they still validate as
 * the identifier/URL they claim to be; malformed values are enveloped like
 * any other external text. Object keys themselves are structural and never
 * wrapped.
 */
function wrapJsonStrings(v: unknown, source: string): unknown {
  if (typeof v === 'string') {
    return wrapUntrusted(v, source);
  }
  if (Array.isArray(v)) {
    return v.map((item) => wrapJsonStrings(item, source));
  }
  if (isObj(v)) {
    return Object.fromEntries(
      Object.entries(v).map(([key, item]) => [
        key,
        wrapStructuralValue(key, item, source),
      ]),
    );
  }
  return v;
}

function wrapStructuralValue(key: string, item: unknown, source: string): unknown {
  if (IDENTIFIER_KEYS.has(key)) {
    // Non-string values under a structural key still recurse: a hostile
    // response could nest prose inside an object/array here, and returning it
    // untouched would leak it raw (type-confusion bypass).
    if (typeof item !== 'string') return wrapJsonStrings(item, source);
    return isSafeIdentifier(item) ? item : wrapUntrusted(item, `${source}:${key}`);
  }
  if (URL_KEYS.has(key)) {
    if (typeof item !== 'string') return wrapJsonStrings(item, source);
    return isSafeUrl(item) ? item : wrapUntrusted(item, `${source}:${key}`);
  }
  return wrapJsonStrings(item, source);
}

/**
 * Validate the structural fields (identifiers, URLs) present at the top
 * level of `obj`: values stay raw only while they match the strict
 * identifier/URL shape, otherwise they are enveloped like any other
 * external text. Non-string values and absent keys pass through untouched.
 * The compact projections (list/status responses) are built by hand, so
 * their top-level `id`/`uuid` never passes through `wrapJsonStrings` —
 * this is what applies the same fail-safe rule to them.
 */
function sanitizeStructuralFields(obj: Obj, source: string): Obj {
  const out: Obj = { ...obj };
  for (const key of Object.keys(out)) {
    if (IDENTIFIER_KEYS.has(key) || URL_KEYS.has(key)) {
      out[key] = wrapStructuralValue(key, out[key], source);
    }
  }
  return out;
}

/**
 * Wrap the workspace-authored `name` on a compact document object, and
 * validate any structural identifier/URL fields before they stay raw.
 */
export function sanitizeDocumentCompact(doc: unknown, source: string): unknown {
  if (!isObj(doc)) return doc;
  return sanitizeStructuralFields({ ...doc, name: wrapStr(doc.name, `${source}:name`) }, source);
}

/**
 * Wrap the external-text fields on a full document-details object: name,
 * created_by, template, recipients, fields, tokens, metadata, tags,
 * grand_total, and linked_objects are all authored in the workspace.
 */
export function sanitizeDocumentDetails(doc: unknown, source: string): unknown {
  if (!isObj(doc)) return doc;
  const out = sanitizeDocumentCompact(doc, source) as Obj;
  out.created_by = wrapJsonStrings(out.created_by, `${source}:created_by`);
  out.template = wrapJsonStrings(out.template, `${source}:template`);
  out.recipients = wrapJsonStrings(out.recipients, `${source}:recipients`);
  out.fields = wrapJsonStrings(out.fields, `${source}:fields`);
  out.tokens = wrapJsonStrings(out.tokens, `${source}:tokens`);
  out.metadata = wrapJsonStrings(out.metadata, `${source}:metadata`);
  out.tags = wrapJsonStrings(out.tags, `${source}:tags`);
  out.grand_total = wrapJsonStrings(out.grand_total, `${source}:grand_total`);
  out.linked_objects = wrapJsonStrings(out.linked_objects, `${source}:linked_objects`);
  return out;
}

/**
 * Wrap the workspace-authored `name` on a template list item, and validate
 * any structural identifier/URL fields before they stay raw.
 */
export function sanitizeTemplate(tpl: unknown, source: string): unknown {
  if (!isObj(tpl)) return tpl;
  return sanitizeStructuralFields({ ...tpl, name: wrapStr(tpl.name, `${source}:name`) }, source);
}

/**
 * Wrap the workspace-authored `name` on a document folder, and validate any
 * structural identifier/URL fields before they stay raw.
 */
export function sanitizeFolder(folder: unknown, source: string): unknown {
  if (!isObj(folder)) return folder;
  return sanitizeStructuralFields({ ...folder, name: wrapStr(folder.name, `${source}:name`) }, source);
}

/** Wrap every non-structural string field on a contact (names, email, company, address, …). */
export function sanitizeContact(contact: unknown, source: string): unknown {
  if (!isObj(contact)) return contact;
  return wrapJsonStrings(contact, source);
}

/**
 * Wrap the workspace-authored `name` on a content-library list item, and
 * validate any structural identifier/URL fields before they stay raw.
 */
export function sanitizeContentLibraryItem(item: unknown, source: string): unknown {
  if (!isObj(item)) return item;
  return sanitizeStructuralFields({ ...item, name: wrapStr(item.name, `${source}:name`) }, source);
}

/**
 * Wrap the external-text fields on a full content-library-item details
 * object: name plus created_by, metadata, tokens, fields, pricing, tags,
 * and roles are all authored in the workspace.
 */
export function sanitizeContentLibraryItemDetails(item: unknown, source: string): unknown {
  if (!isObj(item)) return item;
  const out = sanitizeContentLibraryItem(item, source) as Obj;
  out.created_by = wrapJsonStrings(out.created_by, `${source}:created_by`);
  out.metadata = wrapJsonStrings(out.metadata, `${source}:metadata`);
  out.tokens = wrapJsonStrings(out.tokens, `${source}:tokens`);
  out.fields = wrapJsonStrings(out.fields, `${source}:fields`);
  out.pricing = wrapJsonStrings(out.pricing, `${source}:pricing`);
  out.tags = wrapJsonStrings(out.tags, `${source}:tags`);
  out.roles = wrapJsonStrings(out.roles, `${source}:roles`);
  return out;
}

/** Wrap recipient data (echoed by send responses) — ids and shared links stay raw only when they validate as identifiers/URLs. */
export function sanitizeRecipients(recipients: unknown, source: string): unknown {
  if (!Array.isArray(recipients)) return recipients;
  return recipients.map((r) => (isObj(r) ? wrapJsonStrings(r, source) : r));
}

/** Map a sanitizer over an array, passing non-arrays through unchanged. */
export function sanitizeList(
  items: unknown,
  fn: (item: unknown, source: string) => unknown,
  source: string,
): unknown {
  return Array.isArray(items) ? items.map((it) => fn(it, source)) : items;
}
