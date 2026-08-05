/**
 * Envelope-wrapping for every external-text field the HubSpot API returns to
 * the LLM (AGENTS.md security invariant #6, FOX-3490 remediation).
 *
 * CRM property values, note/engagement bodies, conversation message text, KB
 * article content, form submissions, list/workflow/email names — all of it is
 * text a HubSpot user (or a stranger filling in a form or replying to a
 * conversation) authored, and all of it is a prompt-injection surface. This
 * module is the single auditable policy for wrapping it in
 * `<untrusted-content source="…">` envelopes before it leaves a tool handler.
 *
 * **Deny-by-default, no passthrough.** Every string is enveloped unless its key
 * matches the narrow structural predicate below (identifiers, enums, URLs,
 * timestamps — values the model must echo back verbatim, such as record IDs and
 * pagination cursors). A field-by-field allowlist was rejected: HubSpot
 * responses carry arbitrary custom properties and keep growing new fields, so
 * an allowlist written today silently leaks tomorrow's prose field raw. Object
 * KEYS are never wrapped — they are structural (property names, field names)
 * and the model needs them verbatim for follow-up calls.
 *
 * Non-string leaves (numbers, booleans, null) pass through unchanged.
 */
import { wrapUntrusted } from './untrusted-content.js';

type Obj = Record<string, unknown>;

/**
 * Exact-match structural keys: connector-recognised identifiers/enums whose
 * values consumers string-compare or echo back as tool arguments. Enveloping
 * these would break tool round-trips (pagination cursors, record IDs, OAuth
 * status fields). Keep this list short; everything prose-like is wrapped.
 */
const STRUCTURAL_EXACT_KEYS = new Set([
  'id',
  'type',
  'state',
  'status',
  'category',
  'access',
  'language',
  'operator',
  'direction',
  'email',
  'archived',
  'hidden',
  'url',
  'path',
  'link',
  'after', // pagination cursor — must round-trip verbatim
  'query', // caller-supplied search string echoed back
  'source', // connector-attribution marker
]);

/**
 * Case-sensitive key suffixes that mark structural values. HubSpot mixes
 * camelCase (`listId`, `createdAt`, `signedUrl`) and snake_case
 * (`hs_object_id`, `hs_call_status`) keys, so both casings are covered.
 * Deliberately case-sensitive: a lowercase free-text property named `paid` or
 * `format` must NOT slip through an `id`/`at` suffix match.
 */
const STRUCTURAL_KEY_SUFFIXES = [
  'Id',
  '_id',
  'Ids',
  '_ids',
  'At',
  '_at',
  'Date',
  '_date',
  'Timestamp',
  '_timestamp',
  '_time',
  'Url',
  '_url',
  'Path',
  '_path',
  'Email',
  '_email',
  'Type',
  '_type',
  'Status',
  '_status',
  'State',
  '_state',
  'Direction',
  '_direction',
];

function isStructuralKey(key: string | undefined): boolean {
  if (!key) return false;
  if (STRUCTURAL_EXACT_KEYS.has(key)) return true;
  return STRUCTURAL_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeValue(
  value: unknown,
  source: string,
  key: string | undefined,
  extraLiteralKeys: ReadonlySet<string>,
): unknown {
  if (typeof value === 'string') {
    // JUSTIFIED LITERAL: the key names a structural value (id / enum / URL /
    // timestamp / pagination cursor) whose consumers string-compare or echo it
    // back as a tool argument. `extraLiteralKeys` is the per-surface escape
    // hatch for API-contract identifiers that are attacker-nameable elsewhere
    // (e.g. `name` on a property *definition* is an identifier; `name` on a
    // company record is prose) — callers must keep it minimal.
    return isStructuralKey(key) || (key !== undefined && extraLiteralKeys.has(key))
      ? value
      : wrapUntrusted(value, source);
  }
  if (Array.isArray(value)) {
    // JUSTIFIED LITERAL: an all-string `*_ids` collection is the plural of the
    // structural predicate (e.g. `hs_attachment_ids`). A copy, not the input
    // array; any non-string member drops the whole collection into the walk.
    if (isStructuralKey(key) && value.every((item) => typeof item === 'string')) {
      return [...value];
    }
    // Array items have no key context, so strings inside arrays are always
    // enveloped — arrays of IDs returned under a non-structural key are the
    // caller's own input echoed back (enrol results), never lookup keys.
    return value.map((item) => sanitizeValue(item, source, undefined, extraLiteralKeys));
  }
  // Not a passthrough: strings and arrays are handled above and objects below,
  // so this branch only ever sees a non-string primitive (number / boolean /
  // null / undefined), which carries no injectable text.
  if (!isObj(value)) return value;

  const out: Obj = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = sanitizeValue(childValue, source, childKey, extraLiteralKeys);
  }
  return out;
}

/**
 * Recursively envelope every external-text string in a HubSpot API response.
 * Handles any root shape — object, array, or bare scalar — so an unexpected
 * HTTP-200 body (upstream shape drift) is enveloped rather than passed through
 * raw. Object keys are structural and stay literal; string values are
 * enveloped unless their key is structural (see file header).
 *
 * `source` labels the envelope (e.g. `hubspot:crm/contacts`); keep it stable
 * per surface. `extraLiteralKeys` adds surface-specific structural keys —
 * reserve it for API-contract identifiers (`name` / `groupName` / `value` on
 * property definitions, `name` on form field bindings), never for prose.
 */
export function sanitizeHubSpotResponse<T>(
  value: T,
  source: string,
  extraLiteralKeys: ReadonlySet<string> = new Set(),
): T {
  return sanitizeValue(value, source, undefined, extraLiteralKeys) as T;
}

/**
 * Literal keys for the property-schema surface (`list/get/create/update`
 * property and property-group tools). On this surface `name`, `groupName`,
 * and option `value` are API identifiers the model must echo back verbatim
 * when creating/updating records — not prose. (On CRM *records* the same
 * keys are user-authored text and stay enveloped.)
 */
export const PROPERTY_SCHEMA_LITERAL_KEYS: ReadonlySet<string> = new Set([
  'name',
  'groupName',
  'value',
]);

/**
 * Literal keys for the forms surface. A form field's `name` is the CRM
 * property the field writes to — an identifier the model needs verbatim to
 * map submissions onto contact properties. Submission `value`s and field
 * `label`s stay enveloped (form fillers are untrusted).
 */
export const FORM_LITERAL_KEYS: ReadonlySet<string> = new Set(['name']);
