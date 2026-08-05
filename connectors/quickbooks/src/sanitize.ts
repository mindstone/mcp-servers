/**
 * Envelope-wrapping for the QuickBooks-authored text this connector returns
 * to the LLM (AGENTS.md security invariant #6, FOX-3490 remediation).
 *
 * QuickBooks entities carry free-text fields authored by the user, their
 * customers, or their vendors (DisplayName, memos, line descriptions, …).
 * That text is attacker-influenceable — a malicious counterparty display name
 * or invoice memo is model-visible the moment a list/get tool runs — so it
 * must reach `wrapUntrusted` before it leaves the connector.
 *
 * Two shapes of output are handled differently:
 *
 * - Typed entity payloads (invoices, bills, customers, vendors, employees,
 *   accounts, estimates) go through `sanitizeQboEntity`, a recursive walker
 *   that envelopes the known free-text fields while leaving structural
 *   values (Id, SyncToken, dates, amounts) untouched so they stay usable as
 *   inputs to follow-up tool calls.
 * - Arbitrary-shape payloads (`query_quickbooks`, `get_quickbooks_entity`,
 *   reports) cannot enumerate their fields, so they are enveloped wholesale
 *   with `wrapUntrustedJsonStrings` at the call site — the same approach the
 *   google-workspace sheets handlers use for tabular blobs.
 */
import { wrapUntrusted } from './untrusted-content.js';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * QBO field names whose string values are free text authored in QuickBooks.
 * `name` (lowercase) is the denormalised display text QBO embeds in *Ref
 * objects (CustomerRef.name, ItemRef.name, …). IDs, SyncTokens, dates, and
 * amounts are deliberately NOT in this set.
 */
const FREE_TEXT_FIELDS = new Set([
  'DisplayName',
  'GivenName',
  'MiddleName',
  'FamilyName',
  'CompanyName',
  'FullyQualifiedName',
  'PrintOnCheckName',
  'Name',
  'name',
  'Description',
  'PrivateNote',
  'Notes',
  'Message',
  'Subject',
]);

/**
 * Recursively envelope the known free-text fields anywhere inside a typed
 * QBO payload (handles nested Line arrays, *Ref objects, CustomerMemo).
 * Non-object values and unknown fields pass through unchanged.
 */
export function sanitizeQboEntity(value: unknown, source: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeQboEntity(item, source));
  }
  if (!isObj(value)) return value;

  const out: Obj = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && FREE_TEXT_FIELDS.has(key)) {
      out[key] = wrapUntrusted(item, `${source}:${key}`);
    } else if (key === 'CustomerMemo' && isObj(item)) {
      out[key] = {
        ...item,
        value: typeof item.value === 'string'
          ? wrapUntrusted(item.value, `${source}:CustomerMemo`)
          : item.value,
      };
    } else {
      out[key] = sanitizeQboEntity(item, source);
    }
  }
  return out;
}
