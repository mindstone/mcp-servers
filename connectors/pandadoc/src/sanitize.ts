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
 * the keys in `STRUCTURAL_KEYS` are therefore left raw ONLY when they still
 * look like what the key claims to be (identifier charset / parseable
 * http(s) URL); anything else — e.g. prose or a prompt-injection payload
 * smuggled under an `id` or `url` key — is enveloped like any other
 * attacker-controllable text. Dates, status enums, counts, and booleans are
 * passed through unchanged.
 */
import { wrapUntrusted } from './untrusted-content.js';

type Obj = Record<string, unknown>;

/**
 * Keys whose string values are expected to be identifiers rather than prose.
 * Kept raw so enveloped output stays machine-usable — but only while the
 * value actually matches the identifier charset.
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
 * open them — but only while the value parses as an http(s) URL.
 */
const URL_KEYS = new Set(['url', 'href', 'shared_link', 'avatar']);

/** Conservative identifier charset: PandaDoc ids/uuids are alphanumeric plus separators. */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;

function isSafeIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
}

function isSafeUrl(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
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
    if (typeof item !== 'string') return item;
    return isSafeIdentifier(item) ? item : wrapUntrusted(item, `${source}:${key}`);
  }
  if (URL_KEYS.has(key)) {
    if (typeof item !== 'string') return item;
    return isSafeUrl(item) ? item : wrapUntrusted(item, `${source}:${key}`);
  }
  return wrapJsonStrings(item, source);
}

/** Wrap the workspace-authored `name` on a compact document object. */
export function sanitizeDocumentCompact(doc: unknown, source: string): unknown {
  if (!isObj(doc)) return doc;
  return { ...doc, name: wrapStr(doc.name, `${source}:name`) };
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

/** Wrap the workspace-authored `name` on a template list item. */
export function sanitizeTemplate(tpl: unknown, source: string): unknown {
  if (!isObj(tpl)) return tpl;
  return { ...tpl, name: wrapStr(tpl.name, `${source}:name`) };
}

/** Wrap the workspace-authored `name` on a document folder. */
export function sanitizeFolder(folder: unknown, source: string): unknown {
  if (!isObj(folder)) return folder;
  return { ...folder, name: wrapStr(folder.name, `${source}:name`) };
}

/** Wrap every non-structural string field on a contact (names, email, company, address, …). */
export function sanitizeContact(contact: unknown, source: string): unknown {
  if (!isObj(contact)) return contact;
  return wrapJsonStrings(contact, source);
}

/** Wrap the workspace-authored `name` on a content-library list item. */
export function sanitizeContentLibraryItem(item: unknown, source: string): unknown {
  if (!isObj(item)) return item;
  return { ...item, name: wrapStr(item.name, `${source}:name`) };
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
