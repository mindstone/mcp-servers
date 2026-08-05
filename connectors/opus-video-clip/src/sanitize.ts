/**
 * Envelope-wrapping for the external-text fields Opus returns to the LLM
 * (AGENTS.md security invariant #6).
 *
 * Opus tool handlers surface upstream objects in their JSON results, so the
 * attacker-influenceable fields (project/clip titles, collection and template
 * names, social account display names, generated social copy, upstream error
 * strings) are nested inside those objects. This module is the single,
 * auditable place that enumerates each such field and reaches `wrapUntrusted`.
 *
 * Deliberately NOT wrapped: IDs and handles the model must feed back into
 * subsequent tool calls (projectId, curationId, collectionId, jobId,
 * postAccountId, …) and asset/profile URLs surfaced for the user to open.
 */
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function wrapStr(v: unknown, source: string): unknown {
  return typeof v === 'string' ? wrapUntrusted(v, source) : v;
}

/** Wrap every string inside an upstream `raw` debug dump. */
export function wrapRawDump(v: unknown, source: string): unknown {
  return wrapUntrustedJsonStrings(v, source);
}

/** Map a sanitizer over an array, passing non-arrays through unchanged. */
export function sanitizeList(
  items: unknown,
  fn: (item: unknown, source: string) => unknown,
  source: string,
): unknown {
  return Array.isArray(items) ? items.map((it) => fn(it, source)) : items;
}

/**
 * Wrap free-text fields on a clip-project object.
 *
 * The upstream project object is spread through verbatim, so named-field
 * wrapping alone is not enough: any string field the vendor adds (or an
 * attacker injects via a compromised upstream) would survive unwrapped.
 * Instead, EVERY string value anywhere in the object is enveloped except a
 * small allowlist of structural fields — identifiers the model feeds back
 * into later tool calls (…Id), bounded enums (stage, model, visibility,
 * sourcePlatform), timestamps, and asset URLs (…url/…uri) surfaced for the
 * user to open. This subsumes the previously named `error` / `title` /
 * `name` / `uploadedVideoAttr.title` fields and is fail-closed for unknown
 * future fields.
 */
const STRUCTURAL_PROJECT_STRING_KEYS = new Set([
  'id',
  'stage',
  'model',
  'visibility',
  'sourcePlatform',
  'createdAt',
  'updatedAt',
]);

function isStructuralProjectKey(key: string): boolean {
  if (STRUCTURAL_PROJECT_STRING_KEYS.has(key)) return true;
  if (key.endsWith('Id')) return true; // identifiers fed back into tool calls
  return /url|uri/i.test(key); // asset/profile links surfaced for the user
}

function sanitizeProjectValue(value: unknown, source: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeProjectValue(item, source));
  if (isObj(value)) return sanitizeProjectObject(value, source);
  return value;
}

function sanitizeProjectObject(project: Obj, source: string): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(project)) {
    out[key] =
      typeof value === 'string' && !isStructuralProjectKey(key)
        ? wrapUntrusted(value, `${source}:${key}`)
        : sanitizeProjectValue(value, source);
  }
  return out;
}

export function sanitizeProject(project: unknown, source: string): unknown {
  if (!isObj(project)) return project;
  return sanitizeProjectObject(project, source);
}

/** Wrap the user-authored `title` on an exportable-clip object. */
export function sanitizeClip(clip: unknown, source: string): unknown {
  if (!isObj(clip)) return clip;
  return { ...clip, title: wrapStr(clip.title, `${source}:title`) };
}

/** Wrap the user-authored `name` on a brand-template object. */
export function sanitizeBrandTemplate(template: unknown, source: string): unknown {
  if (!isObj(template)) return template;
  return { ...template, name: wrapStr(template.name, `${source}:name`) };
}

/** Wrap the platform-side display name (`extUserName`) on a social account. */
export function sanitizeSocialAccount(account: unknown, source: string): unknown {
  if (!isObj(account)) return account;
  return { ...account, extUserName: wrapStr(account.extUserName, `${source}:extUserName`) };
}

/** Wrap the user-authored `collectionName` on a collection object. */
export function sanitizeCollection(collection: unknown, source: string): unknown {
  if (!isObj(collection)) return collection;
  return { ...collection, collectionName: wrapStr(collection.collectionName, `${source}:collectionName`) };
}
