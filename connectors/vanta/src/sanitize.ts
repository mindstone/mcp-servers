/**
 * Envelope-wrapping for the external-text fields Vanta returns to the LLM.
 *
 * Vanta tool handlers return raw Manage Vanta API objects inside the tool
 * payload, so attacker-influenceable text (vendor notes, control and policy
 * descriptions, risk-scenario prose, integration error messages, people
 * names) is nested inside those objects rather than passed individually.
 * This module is the single, auditable place that enumerates those fields
 * and reaches `wrapUntrusted` (AGENTS.md security invariant #6, FOX-3490).
 *
 * Wrapping is keyed by field NAME and applies at any depth: Vanta's schemas
 * nest free text inside nested objects (risk-scenario customFields, policy
 * version documents), and per-object hand enumeration would silently miss a
 * field Vanta adds later. Any object entry whose key is listed here and
 * whose value is a string (or string array) is enveloped.
 *
 * Deliberately NOT wrapped: identifiers (`id`, `*Id` keys), enum-like
 * statuses, dates, counts, booleans, URLs, and pagination cursors — the
 * model must quote those verbatim into follow-up tool calls (get-by-id,
 * page_cursor), and enveloping them would corrupt that round-trip.
 */
import { wrapUntrusted } from './untrusted-content.js';

const EXTERNAL_TEXT_KEYS: ReadonlySet<string> = new Set([
  // Names / titles authored in the Vanta tenant
  'name',
  'displayName',
  'shorthandName',
  'firstName',
  'lastName',
  'title',
  'label',
  // Prose
  'description',
  'detailedDescription',
  'note',
  'additionalNotes',
  'remediationNote',
  'deactivateReason',
  // Integration-provided diagnostics
  'connectionErrorMessage',
  // Free-form categorisation
  'category',
  'categories',
  'riskRegister',
  // Risk-scenario custom fields ({label, value}) and vendor contact info
  'value',
  'owner',
  'accountManagerName',
  'accountManagerEmail',
  // People directory entries
  'emailAddress',
]);

const wrapFieldValue = (value: unknown, key: string): unknown => {
  if (typeof value === 'string') {
    return wrapUntrusted(value, `vanta:${key}`);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'string' ? wrapUntrusted(item, `vanta:${key}`) : sanitizeExternalText(item),
    );
  }
  return sanitizeExternalText(value);
};

/**
 * Recursively wrap every string value whose key is an external-text field.
 * Apply to API response data BEFORE assembling the tool payload so
 * connector-authored fields (ok, count, truncation_hint, …) are never
 * mistaken for external text.
 */
export function sanitizeExternalText<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeExternalText(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        EXTERNAL_TEXT_KEYS.has(key) ? wrapFieldValue(item, key) : sanitizeExternalText(item),
      ]),
    ) as T;
  }
  return value;
}
