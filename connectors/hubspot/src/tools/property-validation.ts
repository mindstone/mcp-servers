import { getHubSpotClientAsync } from '../api/hubspot-client.js';
import logger from '../utils/logger.js';
import {
  MAX_REQUESTED_PROPERTIES,
  MAX_REQUESTED_PROPERTY_NAME_LENGTH,
} from './input-limits.js';

/**
 * Read-property validation for CRM reads (search + get).
 *
 * Why this exists: when a caller requests `properties` that don't exist on a
 * HubSpot object (e.g. `hs_time_to_first_agent_reply` instead of the real
 * `time_to_first_agent_reply`), HubSpot silently omits them and returns 200.
 * The agent then gets NO signal it used a bad name — a silent failure. We
 * validate requested names against the object's live property schema and
 * surface a STRUCTURED, model-visible warning (with a conservative did-you-mean)
 * WITHOUT failing the read.
 *
 * Scope: lives in the generic CRM read/search choke points, so it covers every
 * object type (contacts/companies/deals/tickets/leads/products/line-items/...).
 *
 * Untrusted-content note: `warnings` is connector-authored prose ONLY — the
 * variable, externally-influenced strings (model-supplied unknown names,
 * portal-supplied suggestions) live exclusively in the structured
 * `unknownProperties` / `suggestions` fields, never interpolated into prose.
 */

/** A single did-you-mean pairing: a requested unknown name -> closest known name. */
export interface PropertySuggestion {
  requested: string;
  suggestion: string;
}

/** Structured, model-visible validation result attached to read payloads. */
export interface PropertyValidation {
  /** Connector-authored, generic warning prose (no external strings inlined). */
  warnings: string[];
  /** Requested property names that aren't in the object's live schema. */
  unknownProperties?: string[];
  /**
   * Conservative did-you-mean pairings. Only populated when a confident close
   * match exists. Structured so external strings stay out of prose.
   */
  suggestions?: PropertySuggestion[];
}

interface CacheEntry {
  /** Exact-cased known property names (membership test is case-SENSITIVE). */
  names: Set<string>;
  /** Original-cased names, for suggestion generation. */
  original: string[];
  /**
   * Lower-cased -> first exact-cased name, used ONLY to generate a suggestion
   * for a mis-cased request (e.g. `Subject` -> `subject`). Never used for the
   * known-vs-requested membership check (that stays case-sensitive — F2).
   */
  lowerToOriginal: Map<string, string>;
  expiresAt: number;
}

/** Short TTL — single-account-per-process, so a per-object-type memo is safe. */
const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, CacheEntry>();
/** In-flight fetches, so two concurrent first reads share one request (F4). */
const inFlight = new Map<string, Promise<CacheEntry>>();

/** Test-only: reset the in-memory schema cache (and any in-flight fetch). */
export function clearPropertySchemaCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Fetch (and cache) the known property names for an object type.
 * Throws when the schema can't be fetched (caller treats as non-fatal).
 * Promise-memoised: concurrent first reads share a single listProperties call.
 */
async function getKnownProperties(objectType: string): Promise<CacheEntry> {
  const now = Date.now();
  const cached = cache.get(objectType);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  const existing = inFlight.get(objectType);
  if (existing) {
    return existing;
  }

  const fetchPromise = (async (): Promise<CacheEntry> => {
    const client = await getHubSpotClientAsync();
    const response = await client.listProperties(objectType);
    const original = response.results
      .map((property) => property.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    const lowerToOriginal = new Map<string, string>();
    for (const name of original) {
      const lower = name.toLowerCase();
      if (!lowerToOriginal.has(lower)) {
        lowerToOriginal.set(lower, name);
      }
    }
    const entry: CacheEntry = {
      names: new Set(original),
      original,
      lowerToOriginal,
      expiresAt: Date.now() + TTL_MS,
    };
    cache.set(objectType, entry);
    return entry;
  })();

  inFlight.set(objectType, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlight.delete(objectType);
  }
}

/**
 * Levenshtein edit distance — used only as a conservative tiebreaker for
 * did-you-mean. Small inputs (property names), so the simple DP is fine.
 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Below this length we don't suggest at all — short tokens match too much (F3). */
const MIN_SUGGEST_LENGTH = 4;
/** Max normalized edit distance (distance / longerLength) for a confident match. */
const MAX_EDIT_RATIO = 0.34;

/**
 * DoS bounds (Medium-severity hardening). The validation path runs an O(n*m)
 * edit-distance over the property catalog, so unbounded model-supplied input
 * could pin CPU/heap. These caps bound the work BY CONSTRUCTION while staying
 * generous for legitimate use (a portal has ~50-150 properties). The same
 * `properties` array caps are mirrored into the tool input schemas
 * (`MAX_VALIDATED_PROPERTIES` -> `maxItems`, `MAX_PROPERTY_NAME_LENGTH` ->
 * item `maxLength`) so they stay in lockstep — see PROPERTIES_SCHEMA_BOUNDS.
 */
/**
 * Max number of requested names actually processed through validation, and the
 * per-name length cap. Single source of truth lives in input-limits.ts (shared
 * with the tool input schemas) so the schema cap and the runtime cap match.
 */
const MAX_VALIDATED_PROPERTIES = MAX_REQUESTED_PROPERTIES;
const MAX_PROPERTY_NAME_LENGTH = MAX_REQUESTED_PROPERTY_NAME_LENGTH;
/** Above this length we report the name as unknown but never run editDistance. */
const MAX_SUGGEST_NAME_LENGTH = 64;
/** Cap on how many unknown names we return/log, to bound payload + log size. */
const MAX_REPORTED_UNKNOWN = 50;
/** A safe property-identifier shape — suggestions must match (F2 defense-in-depth). */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_]+$/;

/**
 * Conservative did-you-mean. Deliberately under-reaches:
 *
 * 1. A mis-case of an exact known name -> suggest the exact casing (F2 partner).
 * 2. Otherwise require a confident close match by NORMALIZED edit distance
 *    (distance / max-length <= MAX_EDIT_RATIO), and only when it's UNIQUE
 *    (no tie). Very short requested names get no suggestion at all (F3).
 *
 * Bidirectional substring matching was removed: it let short inputs (`id`,
 * `hs`, `name`) pull arbitrary names out of a large catalog.
 */
function suggestClosest(unknown: string, known: CacheEntry): string | undefined {
  const lower = unknown.toLowerCase();

  // 1. Pure mis-case: the lower-cased form matches a known name exactly.
  const exactMisCase = known.lowerToOriginal.get(lower);
  const candidate1 = exactMisCase && exactMisCase !== unknown ? exactMisCase : undefined;
  if (candidate1) {
    return SAFE_IDENTIFIER.test(candidate1) ? candidate1 : undefined;
  }

  // 2. Confident, unique close match by normalized edit distance.
  // DoS bound: never run the O(n*m) editDistance on pathologically long names —
  // report them as unknown with no suggestion instead.
  if (unknown.length < MIN_SUGGEST_LENGTH || unknown.length > MAX_SUGGEST_NAME_LENGTH) {
    return undefined;
  }

  let best: { name: string; distance: number } | undefined;
  let tie = false;
  for (const candidate of known.original) {
    if (candidate.length > MAX_SUGGEST_NAME_LENGTH) continue;
    const distance = editDistance(candidate.toLowerCase(), lower);
    const ratio = distance / Math.max(candidate.length, unknown.length);
    if (ratio > MAX_EDIT_RATIO) continue;
    if (!best || distance < best.distance) {
      best = { name: candidate, distance };
      tie = false;
    } else if (distance === best.distance && candidate !== best.name) {
      tie = true;
    }
  }

  // Don't guess when the closest match is ambiguous.
  if (!best || tie) return undefined;
  // F2 defense-in-depth: never emit a suggestion that isn't a safe identifier,
  // so the connector's safety doesn't rely on HubSpot's internal-name contract.
  return SAFE_IDENTIFIER.test(best.name) ? best.name : undefined;
}

/**
 * Coerce a raw `requested` argument into a clean, BOUNDED string[] without
 * throwing. server.ts casts raw tool args (`as unknown as ...`), so the runtime
 * shape isn't guaranteed — non-arrays / non-string entries must not break the
 * read. DoS bound (F1): drop entries longer than MAX_PROPERTY_NAME_LENGTH and
 * cap the number of names processed at MAX_VALIDATED_PROPERTIES BEFORE any
 * expensive (edit-distance) work runs.
 */
function normalizeRequested(requested: unknown): string[] {
  if (!Array.isArray(requested)) return [];
  const cleaned: string[] = [];
  for (const name of requested) {
    if (typeof name !== 'string') continue;
    if (name.length === 0 || name.length > MAX_PROPERTY_NAME_LENGTH) continue;
    cleaned.push(name);
    if (cleaned.length >= MAX_VALIDATED_PROPERTIES) break;
  }
  return cleaned;
}

/**
 * Validate requested read-property names against the object's live schema.
 *
 * Fully non-fatal (F6): this never throws. Any unexpected runtime shape or
 * lookup failure resolves to either `undefined` (nothing to warn) or a
 * structured warning — the caller always returns HubSpot's data regardless.
 *
 * - Returns `undefined` when there's nothing to warn about (no valid string
 *   properties requested, or all requested names are valid).
 * - Returns a structured warning when one or more names are unknown, or when
 *   the schema lookup itself failed (validation unavailable).
 */
export async function validateRequestedProperties(
  objectType: string,
  requested: string[] | undefined,
): Promise<PropertyValidation | undefined> {
  try {
    const names = normalizeRequested(requested);
    if (names.length === 0) {
      return undefined;
    }

    let known: CacheEntry;
    try {
      known = await getKnownProperties(objectType);
    } catch (error) {
      // Non-fatal: the read must still succeed. Surface an observable, structured
      // warning AND a structured log so the degraded state isn't silent.
      logger.warn(
        { objectType, requestedCount: names.length, err: error },
        'Property-name validation unavailable: listProperties lookup failed',
      );
      return {
        warnings: [
          'Could not validate the requested property names because the property schema lookup failed. The requested properties were still sent to HubSpot, but any unknown names will be silently omitted by HubSpot.',
        ],
      };
    }

    // Case-SENSITIVE membership test (F2): HubSpot internal names are
    // case-sensitive, and a mis-cased name (e.g. `Subject` vs `subject`) is
    // silently omitted just like an unknown name — so it must be flagged.
    const allUnknown = names.filter((name) => !known.names.has(name));
    if (allUnknown.length === 0) {
      return undefined;
    }

    // DoS bound (F1): cap what we return/log so the payload and log lines stay
    // bounded regardless of input size.
    const truncated = allUnknown.length > MAX_REPORTED_UNKNOWN;
    const unknownProperties = truncated ? allUnknown.slice(0, MAX_REPORTED_UNKNOWN) : allUnknown;

    const suggestions: PropertySuggestion[] = [];
    for (const name of unknownProperties) {
      const suggestion = suggestClosest(name, known);
      if (suggestion) {
        suggestions.push({ requested: name, suggestion });
      }
    }

    // Connector-authored prose ONLY — names live in the structured fields (F1).
    const warnings = [
      'Some requested properties were not found on this object type and were silently ignored by HubSpot. See unknownProperties for the names, suggestions for likely-intended matches, and list_hubspot_properties for the full set of valid property names.',
    ];
    if (truncated) {
      warnings.push(
        `unknownProperties is truncated to the first ${MAX_REPORTED_UNKNOWN} of ${allUnknown.length} unknown names.`,
      );
    }

    // Don't log unbounded raw names — log a count and the (bounded) sample only.
    logger.warn(
      {
        objectType,
        unknownCount: allUnknown.length,
        truncated,
        reportedCount: unknownProperties.length,
        suggestionCount: suggestions.length,
      },
      'Requested unknown property names on CRM read',
    );

    return {
      warnings,
      unknownProperties,
      ...(suggestions.length > 0 ? { suggestions } : {}),
    };
  } catch (error) {
    // Belt-and-braces (F6): nothing in validation may abort a successful read.
    logger.warn(
      { objectType, err: error },
      'Property-name validation skipped due to an unexpected error',
    );
    return undefined;
  }
}

/** A read payload with an optional, model-visible property-validation warning. */
export type WithPropertyValidation<T> = T & { propertyValidation?: PropertyValidation };

/**
 * Merge a validation result onto a read payload as model-visible structured
 * fields. The result is JSON-serialized verbatim into the tool response text
 * (server.ts), so these fields ride along to the model. When there's nothing to
 * warn about the `propertyValidation` field is simply absent.
 */
export function attachPropertyValidation<T extends object>(
  result: T,
  validation: PropertyValidation | undefined,
): WithPropertyValidation<T> {
  if (!validation) return result;
  return { ...result, propertyValidation: validation };
}
