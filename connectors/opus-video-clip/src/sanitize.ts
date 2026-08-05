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
 * Wrap free-text fields on a clip-project object (`error`, `title`, `name`,
 * and the user-supplied `uploadedVideoAttr.title` echo).
 */
export function sanitizeProject(project: unknown, source: string): unknown {
  if (!isObj(project)) return project;
  const out: Obj = { ...project };
  out.error = wrapStr(out.error, `${source}:error`);
  out.title = wrapStr(out.title, `${source}:title`);
  out.name = wrapStr(out.name, `${source}:name`);
  if (isObj(out.uploadedVideoAttr)) {
    out.uploadedVideoAttr = {
      ...out.uploadedVideoAttr,
      title: wrapStr(out.uploadedVideoAttr.title, `${source}:uploadedVideoAttr.title`),
    };
  }
  return out;
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
