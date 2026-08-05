/**
 * Envelope-wrapping for ServiceNow Table API records returned to the LLM.
 *
 * Table API records are authored in the ServiceNow instance by end users
 * (callers, fulfilers, KB authors) and are therefore attacker-controllable
 * prompt-injection surfaces. AGENTS.md security invariant #6 requires every
 * model-visible string from an external system to reach the
 * `<untrusted-content>` envelope before it is returned.
 *
 * The walk is deny-by-default: every string value is enveloped unless its key
 * names a structural value the connector recognises — a machine-generated
 * identifier, a timestamp, or an instance-controlled choice-list display
 * value — AND the value matches a conservative printable-character shape
 * (anything else fails safe into an envelope). Structural values stay literal
 * so identifiers (sys_id, number) can be copied verbatim into follow-up tool
 * calls. Free-text fields a record author types (short_description,
 * description, work_notes, names, emails, …) are always enveloped, including
 * fields this connector does not surface today.
 */
import { wrapUntrusted } from './untrusted-content.js';

type Obj = Record<string, unknown>;

/**
 * Keys whose values stay literal: machine-generated identifiers, timestamps,
 * and instance-controlled choice-list display values. Everything else is
 * treated as author-controlled free text and enveloped.
 */
const STRUCTURAL_LITERAL_KEYS = new Set([
  // identifiers (copied into follow-up tool calls — must round-trip verbatim)
  'sys_id',
  'number',
  // choice-list display values (instance-configured vocabulary, not free text)
  'state',
  'priority',
  'urgency',
  'impact',
  'risk',
  'active',
  'approval',
  'workflow_state',
  'article_type',
  'type',
  'contact_type',
  'escalation',
  'made_sla',
  'close_code',
  // timestamps / durations
  'sys_created_on',
  'sys_updated_on',
  'opened_at',
  'resolved_at',
  'closed_at',
  'start_date',
  'end_date',
  'due_date',
  'calendar_duration',
  // other machine-generated values
  'sys_mod_count',
  'sys_class_name',
  'price',
  'recurring_price',
  'order',
]);

/**
 * Conservative shape for a value allowed to stay literal under a structural
 * key: printable identifier/choice-list/timestamp characters only — no angle
 * brackets, quotes, backslash, or control characters, so a literal can never
 * carry an envelope close-tag breakout. A structural value that does not match
 * (e.g. an instance-customised choice-list display value containing markup)
 * fails safe: it is enveloped like free text instead of passed through raw.
 */
const STRUCTURAL_VALUE_PATTERN = /^[\w .,:#+$()/-]{1,200}$/;

function isStructuralLiteral(key: string | undefined, value: string): boolean {
  return (
    key !== undefined &&
    STRUCTURAL_LITERAL_KEYS.has(key) &&
    STRUCTURAL_VALUE_PATTERN.test(value)
  );
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeValue(value: unknown, source: string, key?: string): unknown {
  if (typeof value === 'string') {
    // An empty string carries no injectable content; leave it as-is rather
    // than emitting an empty envelope.
    if (value === '') return value;
    if (isStructuralLiteral(key, value)) return value;
    return wrapUntrusted(value, key !== undefined ? `${source}:${key}` : source);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, source));
  }
  if (isObj(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, source, childKey),
      ]),
    );
  }
  // Non-string primitives (number / boolean / null / undefined) carry no text.
  return value;
}

/**
 * Return a copy of a single Table API record with every free-text string
 * enveloped. A non-object root (unexpected upstream shape) is walked by the
 * same deny-by-default rule rather than passed through raw.
 */
export function sanitizeRecord<T>(record: T, source: string): T {
  return sanitizeValue(record, source) as T;
}

/**
 * Return copies of a list of Table API records with free-text strings
 * enveloped.
 */
export function sanitizeRecords<T>(records: T[], source: string): T[] {
  return records.map((record) => sanitizeRecord(record, source));
}
