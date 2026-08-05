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
 * an allowlist written today silently leaks tomorrow's prose field raw.
 *
 * Three scoping rules keep the structural predicate from becoming a name-based
 * allowlist an attacker can collide with:
 *
 * 1. **The record `properties` bag is always untrusted.** Custom properties are
 *    tenant-defined, so nothing stops a property being named `status`, `type`,
 *    or `email`. Inside a `properties` object every string value is enveloped
 *    regardless of key name — structural keys and literal rules do not apply.
 *    Record IDs round-trip via the top-level `id`, which stays literal.
 * 2. **Per-surface literal rules are path-scoped, not global.** A rule like
 *    "option `value` on a property *definition* is an identifier" only applies
 *    at the documented object path (`options[]` items), so a nested `value`
 *    elsewhere in the response stays enveloped.
 * 3. **Object keys are defanged, never enveloped.** Keys are structural
 *    identifiers the model needs verbatim for follow-up calls, so they are not
 *    wrapped — but any close-tag breakout sequence inside a key is escaped so
 *    a hostile upstream key cannot forge an envelope boundary.
 *
 * The walker also carries a depth and node budget: a pathologically nested or
 * oversized response fails closed (throws) instead of exhausting the stack.
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
 *
 * These only apply OUTSIDE a record `properties` bag — inside it, every value
 * is enveloped no matter what the custom property is named.
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

/**
 * Fail-closed budgets for the recursive walk. Real HubSpot responses are
 * shallow (search result -> properties -> value is ~4 levels) and a 100-record
 * page with a full property bag is a few thousand nodes; both limits are far
 * above legitimate traffic and far below stack-exhaustion territory.
 */
const MAX_SANITIZE_DEPTH = 40;
const MAX_SANITIZE_NODES = 100_000;

// Mirrors the close-tag sentinel escaping in the vendored untrusted-content.ts
// (kept byte-for-byte with the shared reference, so not imported from). Object
// keys are not enveloped — they must round-trip as identifiers — but a key
// smuggling a close-tag variant would otherwise forge an envelope boundary in
// model-visible output.
const UNTRUSTED_CLOSE_TAG_VARIANT = /<\/untrusted-content\s*>/gi;
const ESCAPED_UNTRUSTED_CLOSE_TAG = '<\\/untrusted-content>';

function defangKey(key: string): string {
  return key.replace(UNTRUSTED_CLOSE_TAG_VARIANT, ESCAPED_UNTRUSTED_CLOSE_TAG);
}

/**
 * A path-scoped exception for API-contract identifiers that are
 * attacker-nameable elsewhere (e.g. `name` on a property *definition* is an
 * identifier; `name` on a company record is prose).
 *
 * `path` is the object-key path of the objects on which `keys` stay literal,
 * with array hops transparent (an item of `options[]` sits at path
 * ['options']). An empty path matches the root object only. The match is
 * EXACT — a rule covers only the documented response shapes, so a surface
 * that nests the same shape under `results` enumerates both paths explicitly.
 * A suffix match would let an attacker-controlled parent recreate a trusted
 * tail (`audit.options[].value`) and inherit the exception.
 */
export interface SanitizeLiteralRule {
  path: readonly string[];
  keys: ReadonlySet<string>;
}

function matchesLiteralRule(
  key: string,
  objectPath: readonly string[],
  rules: readonly SanitizeLiteralRule[],
): boolean {
  for (const rule of rules) {
    if (!rule.keys.has(key)) continue;
    if (rule.path.length !== objectPath.length) continue;
    if (rule.path.every((segment, index) => objectPath[index] === segment)) {
      return true;
    }
  }
  return false;
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface WalkContext {
  source: string;
  rules: readonly SanitizeLiteralRule[];
  nodes: number;
}

function budgetExceeded(budget: string): never {
  throw new Error(
    `HubSpot response exceeds the sanitizer ${budget} budget; refusing to pass it to the model unsanitized.`,
  );
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  containerPath: readonly string[],
  inRecordProperties: boolean,
  depth: number,
  ctx: WalkContext,
): unknown {
  ctx.nodes += 1;
  if (ctx.nodes > MAX_SANITIZE_NODES) budgetExceeded('node-count');
  if (depth > MAX_SANITIZE_DEPTH) budgetExceeded('depth');

  if (typeof value === 'string') {
    // JUSTIFIED LITERAL: outside a record `properties` bag, the key names a
    // structural value (id / enum / URL / timestamp / pagination cursor) whose
    // consumers string-compare or echo it back as a tool argument, or a
    // path-scoped per-surface rule marks it as an API-contract identifier.
    // Inside `properties` nothing is literal — custom property names are
    // tenant-defined and can collide with any structural key.
    const literal =
      !inRecordProperties &&
      key !== undefined &&
      (isStructuralKey(key) || matchesLiteralRule(key, containerPath, ctx.rules));
    return literal ? value : wrapUntrusted(value, ctx.source);
  }
  if (Array.isArray(value)) {
    // JUSTIFIED LITERAL: an all-string `*_ids` collection is the plural of the
    // structural predicate (e.g. `hs_attachment_ids`). A copy, not the input
    // array; any non-string member drops the whole collection into the walk.
    if (!inRecordProperties && isStructuralKey(key) && value.every((item) => typeof item === 'string')) {
      return [...value];
    }
    // Array items have no key context, so strings inside arrays are always
    // enveloped — arrays of IDs returned under a non-structural key are the
    // caller's own input echoed back (enrol results), never lookup keys.
    // Arrays are path-transparent: an item of `results[]` sits at ['results'].
    const arrayPath = key === undefined ? containerPath : [...containerPath, key];
    return value.map((item) => sanitizeValue(item, undefined, arrayPath, inRecordProperties, depth + 1, ctx));
  }
  // Not a passthrough: strings and arrays are handled above and objects below,
  // so this branch only ever sees a non-string primitive (number / boolean /
  // null / undefined), which carries no injectable text.
  if (!isObj(value)) return value;

  const ownPath = key === undefined ? containerPath : [...containerPath, key];
  const out: Obj = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    // A `properties` object on a CRM record holds tenant-defined custom
    // property values: everything below it is untrusted regardless of key name.
    const childInRecordProperties = inRecordProperties || childKey === 'properties';
    out[defangKey(childKey)] = sanitizeValue(
      childValue,
      childKey,
      ownPath,
      childInRecordProperties,
      depth + 1,
      ctx,
    );
  }
  return out;
}

/**
 * Recursively envelope every external-text string in a HubSpot API response.
 * Handles any root shape — object, array, or bare scalar — so an unexpected
 * HTTP-200 body (upstream shape drift) is enveloped rather than passed through
 * raw. Object keys are structural and stay literal (breakout-defanged); string
 * values are enveloped unless their key is structural (see file header).
 *
 * `source` labels the envelope (e.g. `hubspot:crm/contacts`); keep it stable
 * per surface. `literalRules` adds path-scoped, surface-specific structural
 * keys — reserve it for API-contract identifiers (`name` / `groupName` on
 * property definitions, option `value`s, form field bindings), never for prose.
 */
export function sanitizeHubSpotResponse<T>(
  value: T,
  source: string,
  literalRules: readonly SanitizeLiteralRule[] = [],
): T {
  const ctx: WalkContext = { source, rules: literalRules, nodes: 0 };
  return sanitizeValue(value, undefined, [], false, 0, ctx) as T;
}

/**
 * Literal rules for the property-schema surface (`list/get/create/update`
 * property and property-group tools). On this surface `name` and `groupName`
 * are API identifiers the model must echo back verbatim when creating/updating
 * records, and option `value`s are the identifiers written into records. The
 * rules are pinned to the exact documented response shapes — a definition
 * arrives bare (get/create/update) or under `results` (list), and option
 * identifiers live under the definition's `options` array — so a nested
 * `name` or `value` anywhere else (e.g. an attacker-named `audit.options`
 * subtree) stays enveloped. (On CRM *records* the same keys are user-authored
 * text and stay enveloped via the `properties` rule.)
 */
export const PROPERTY_SCHEMA_LITERAL_RULES: readonly SanitizeLiteralRule[] = [
  { path: [], keys: new Set(['name', 'groupName']) },
  { path: ['results'], keys: new Set(['name', 'groupName']) },
  { path: ['options'], keys: new Set(['value']) },
  { path: ['results', 'options'], keys: new Set(['value']) },
];

/**
 * Literal rules for the forms surface. A form field's `name` is the CRM
 * property the field writes to — an identifier the model needs verbatim to map
 * submissions onto contact properties. Scoped to the exact documented binding
 * shapes (field definitions, bare or under a list `results`, and submission
 * values); submission `value`s, field `label`s, and the form's own display
 * name stay enveloped (form fillers and form authors are untrusted, and forms
 * are referenced by ID, not name).
 */
export const FORM_LITERAL_RULES: readonly SanitizeLiteralRule[] = [
  { path: ['fieldGroups', 'fields'], keys: new Set(['name']) },
  { path: ['results', 'fieldGroups', 'fields'], keys: new Set(['name']) },
  { path: ['values'], keys: new Set(['name']) },
  { path: ['results', 'values'], keys: new Set(['name']) },
];
