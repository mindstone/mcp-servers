/**
 * Envelope-wrapping for the QuickBooks-authored text this connector returns
 * to the LLM (AGENTS.md security invariant #6, FOX-3490 remediation).
 *
 * QuickBooks entities carry free-text fields authored by the user, their
 * customers, or their vendors (DisplayName, memos, line descriptions, email
 * addresses, postal addresses, …). That text is attacker-influenceable — a
 * malicious counterparty display name or invoice memo is model-visible the
 * moment a list/get tool runs — so it must reach `wrapUntrusted` before it
 * leaves the connector.
 *
 * Two shapes of output are handled differently:
 *
 * - Typed entity payloads (invoices, bills, customers, vendors, employees,
 *   accounts, estimates) go through `sanitizeQboEntity`, a recursive walker
 *   described below.
 * - Arbitrary-shape payloads (`query_quickbooks`, `get_quickbooks_entity`,
 *   reports) cannot enumerate their fields, so they are enveloped wholesale
 *   with `wrapUntrustedJsonStrings` at the call site — the same approach the
 *   google-workspace sheets handlers use for tabular blobs.
 *
 * **Deny-by-default, no passthrough.** `sanitizeQboEntity` envelopes every
 * string unless its key matches the narrow structural predicate below
 * (identifiers, sync tokens, Ref ID markers, enums, dates/timestamps —
 * values the model must echo back verbatim as follow-up tool arguments, or
 * format-constrained tokens that cannot carry prose). A field-by-field
 * allow-list of free-text keys was rejected: the QBO entity surface keeps
 * growing new vendor-defined fields (and the review already caught
 * `PrimaryEmailAddr.Address`, `PrimaryPhone.FreeFormNumber`, and postal
 * address strings slipping through one), so an allow-list written today
 * silently leaks tomorrow's prose field raw.
 */
import { wrapUntrusted } from './untrusted-content.js';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Exact-match structural keys: QBO identifiers, sync tokens, Ref ID markers,
 * and enum fields whose values consumers string-compare or echo back as tool
 * arguments. Keep this list short; everything prose-like is wrapped.
 *
 * `value` is the *Ref ID marker (CustomerRef.value, ItemRef.value, …). The
 * one free-text `value` in typed QBO payloads — `CustomerMemo.value` — is
 * special-cased in the walker below, so it is still enveloped.
 */
const STRUCTURAL_EXACT_KEYS = new Set([
  'Id',
  'SyncToken',
  'value',
  'Type',
  'DetailType',
  'domain',
  'TxnStatus',
  'EmailStatus',
  'AccountType',
  'AccountSubType',
  'PaymentType',
  'EntityType',
]);

/**
 * Case-sensitive key suffixes marking dates, timestamps, and identifiers
 * (TxnDate, DueDate, ExpirationDate, MetaData.CreateTime, DefinitionId, …).
 * Deliberately case-sensitive: a lowercase free-text field named `update`
 * or `candidate` must NOT slip through a `date`/`time` suffix match.
 */
const STRUCTURAL_KEY_SUFFIXES = ['Id', 'Date', 'Time'];

function isStructuralKey(key: string): boolean {
  if (STRUCTURAL_EXACT_KEYS.has(key)) return true;
  return STRUCTURAL_KEY_SUFFIXES.some(
    (suffix) => key.length > suffix.length && key.endsWith(suffix),
  );
}

/**
 * Recursively envelope every string inside a typed QBO payload unless its
 * key is structural (handles nested Line arrays, *Ref objects, addresses,
 * contact points). `CustomerMemo.value` is free text despite the `value`
 * key, so it is enveloped explicitly. Non-object values pass through
 * unchanged.
 */
export function sanitizeQboEntity(value: unknown, source: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeQboEntity(item, source));
  }
  if (!isObj(value)) return value;

  const out: Obj = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'CustomerMemo' && isObj(item)) {
      out[key] = {
        ...item,
        value: typeof item.value === 'string'
          ? wrapUntrusted(item.value, `${source}:CustomerMemo`)
          : item.value,
      };
    } else if (typeof item === 'string' && !isStructuralKey(key)) {
      out[key] = wrapUntrusted(item, `${source}:${key}`);
    } else {
      out[key] = sanitizeQboEntity(item, source);
    }
  }
  return out;
}
