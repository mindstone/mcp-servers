/**
 * Envelope-wrapping for the free-text fields Humaans returns to the LLM.
 *
 * People responses are field-allowlisted / sensitive-field-denylisted in
 * `tools/people.ts`, but time away entries, allocations, job roles, person
 * profiles, locations, and the company record come back as raw API objects
 * whose free-text fields are authored in Humaans (by employees, managers, or
 * admins): `note` / `reviewNote`, the `name` of embedded `timeAwayType` /
 * `timeAwayPolicy` objects, profile free text (`bio`, names, social links,
 * team names, job title / department), and location / company names. Those
 * are attacker-controlled strings, so they reach `wrapUntrusted` here before
 * the object is returned (AGENTS.md security invariant #6). This module is
 * the single, auditable place that enumerates those fields.
 */
import { wrapUntrusted } from './untrusted-content.js';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function wrapStr(v: unknown, source: string): unknown {
  return typeof v === 'string' ? wrapUntrusted(v, source) : v;
}

function wrapFields(value: unknown, fields: string[], source: string): unknown {
  if (!isObj(value)) return value;
  const out: Obj = { ...value };
  for (const field of fields) {
    out[field] = wrapStr(out[field], `${source}:${field}`);
  }
  return out;
}

/** Wrap the `name` of an embedded object (e.g. `timeAwayType` / `timeAwayPolicy`). */
function wrapNestedName(value: unknown, key: string, source: string): unknown {
  if (!isObj(value)) return value;
  const nested = value[key];
  if (!isObj(nested)) return value;
  return { ...value, [key]: { ...nested, name: wrapStr(nested.name, `${source}:${key}.name`) } };
}

/** Wrap free-text fields of an embedded object (e.g. `jobRole` on a person). */
function wrapNestedFields(value: unknown, key: string, fields: string[], source: string): unknown {
  if (!isObj(value)) return value;
  const nested = value[key];
  if (!isObj(nested)) return value;
  return { ...value, [key]: wrapFields(nested, fields, `${source}:${key}`) };
}

/** Wrap the `name` of each entry in an array of embedded objects (e.g. `teams`). */
function wrapNameList(value: unknown, key: string, source: string): unknown {
  if (!isObj(value)) return value;
  const list = value[key];
  if (!Array.isArray(list)) return value;
  return {
    ...value,
    [key]: list.map((item) =>
      isObj(item) ? { ...item, name: wrapStr(item.name, `${source}:${key}.name`) } : item,
    ),
  };
}

/** Wrap every string entry of an array field (e.g. `socialLinks`). */
function wrapStringListField(value: unknown, field: string, source: string): unknown {
  if (!isObj(value)) return value;
  const list = value[field];
  if (!Array.isArray(list)) return value;
  return { ...value, [field]: list.map((item) => wrapStr(item, `${source}:${field}`)) };
}

/** Wrap the note fields and embedded type name on a time away entry. */
export function sanitizeTimeAwayEntry(entry: unknown, source: string): unknown {
  return wrapNestedName(wrapFields(entry, ['note', 'reviewNote'], source), 'timeAwayType', source);
}

/** Wrap the embedded policy name on a time away allocation. */
export function sanitizeTimeAwayAllocation(allocation: unknown, source: string): unknown {
  return wrapNestedName(allocation, 'timeAwayPolicy', source);
}

/** Wrap the admin-authored job title, department, and note on a job role. */
export function sanitizeJobRole(role: unknown, source: string): unknown {
  return wrapFields(role, ['jobTitle', 'department', 'note'], source);
}

/** Wrap the admin-authored name on a time away type. */
export function sanitizeTimeAwayType(timeAwayType: unknown, source: string): unknown {
  return wrapFields(timeAwayType, ['name'], source);
}

// Self- or manager-editable free text on a person profile. Structured tokens
// (id, email, status, dates, timezone) stay raw so they remain usable as
// filter / parameter values; future free-text fields Humaans adds must be
// enumerated here.
const PERSON_FREE_TEXT_FIELDS = [
  'firstName',
  'lastName',
  'preferredName',
  'bio',
  'remoteCity',
  'remoteCountry',
  'jobTitle',
  'department',
];

/**
 * Wrap the free-text fields on a person profile (full or compact): names,
 * bio, remote location, job title / department / note (top-level and inside
 * the embedded `jobRole`), embedded team names, and social links.
 */
export function sanitizePersonProfile(person: unknown, source: string): unknown {
  let out = wrapFields(person, PERSON_FREE_TEXT_FIELDS, source);
  out = wrapNestedFields(out, 'jobRole', ['jobTitle', 'department', 'note'], source);
  out = wrapNameList(out, 'teams', source);
  out = wrapStringListField(out, 'socialLinks', source);
  return out;
}

/** Wrap the admin-authored label/city/country on a location. */
export function sanitizeLocation(location: unknown, source: string): unknown {
  return wrapFields(location, ['label', 'city', 'country'], source);
}

/** Wrap the admin-authored name on the company record. */
export function sanitizeCompany(company: unknown, source: string): unknown {
  return wrapFields(company, ['name'], source);
}

/** Map a sanitizer over an array, passing non-arrays through unchanged. */
export function sanitizeList(
  items: unknown,
  fn: (item: unknown, source: string) => unknown,
  source: string,
): unknown {
  return Array.isArray(items) ? items.map((it) => fn(it, source)) : items;
}
