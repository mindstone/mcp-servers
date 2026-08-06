/**
 * Response formatting helpers for Wise API data.
 *
 * Strings returned by Wise that are authored by external parties (recipient
 * names and bank details, transfer references, statement descriptions and
 * merchant names, activity titles, savings-jar names, quote notices) are
 * wrapped in `<untrusted-content source="…">…</untrusted-content>` envelopes
 * via the canonical shared helper (vendored at `./untrusted-content.ts`) so
 * the host LLM treats them as data, not instructions. Connector-controlled
 * metadata (ids, numeric amounts, currency codes, statuses, timestamps) is
 * left raw.
 */

import type {
  WiseProfile,
  WiseBalance,
  WiseRecipient,
  WiseQuote,
  WiseTransfer,
  WiseStatement,
  WiseStatementTransaction,
  WiseActivity,
} from './types.js';
import { wrapUntrusted, wrapUntrustedJsonStrings } from './untrusted-content.js';

const PROFILE_SOURCE = 'wise:profile';
const BALANCE_SOURCE = 'wise:balance';
const RECIPIENT_SOURCE = 'wise:recipient';
const QUOTE_SOURCE = 'wise:quote';
const TRANSFER_SOURCE = 'wise:transfer';
const STATEMENT_SOURCE = 'wise:statement';
const ACTIVITY_SOURCE = 'wise:activity';

/**
 * Wrap an optional external-text field in an `<untrusted-content>` envelope.
 * Returns `undefined` for null/undefined/empty input so callers can skip the
 * field entirely rather than emit an empty envelope.
 */
function wrapField(s: string | null | undefined, source: string): string | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  return wrapUntrusted(s, source);
}

/**
 * Recursively wrap every string VALUE reachable inside `value`. Object keys
 * are part of the connector's output contract and stay raw; free-form maps
 * whose KEYS are also authored in Wise (recipient `details`) are wrapped
 * with `wrapUntrustedJsonStrings` instead, which envelopes keys as well.
 */
function wrapValuesDeep<T>(value: T, source: string): T {
  if (typeof value === 'string') {
    return wrapUntrusted(value, source) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => wrapValuesDeep(item, source)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, wrapValuesDeep(item, source)]),
    ) as T;
  }
  return value;
}

/** Profile names, contact details, and address lines are account-holder-authored. */
export function wrapProfile(profile: WiseProfile): WiseProfile {
  return {
    ...profile,
    fullName: wrapField(profile.fullName, PROFILE_SOURCE),
    firstName: wrapField(profile.firstName, PROFILE_SOURCE),
    lastName: wrapField(profile.lastName, PROFILE_SOURCE),
    preferredName: wrapField(profile.preferredName, PROFILE_SOURCE),
    businessName: wrapField(profile.businessName, PROFILE_SOURCE),
    email: wrapField(profile.email, PROFILE_SOURCE),
    phoneNumber: wrapField(profile.phoneNumber, PROFILE_SOURCE),
    contactDetails: profile.contactDetails
      ? {
          email: wrapField(profile.contactDetails.email, PROFILE_SOURCE),
          phoneNumber: wrapField(profile.contactDetails.phoneNumber, PROFILE_SOURCE),
        }
      : undefined,
    address: profile.address
      ? {
          ...profile.address,
          addressFirstLine: wrapField(profile.address.addressFirstLine, PROFILE_SOURCE),
          city: wrapField(profile.address.city, PROFILE_SOURCE),
          postCode: wrapField(profile.address.postCode, PROFILE_SOURCE),
          stateCode: wrapField(profile.address.stateCode, PROFILE_SOURCE),
        }
      : undefined,
  };
}

/** Savings-jar names are user-authored; currencies/amounts are not. */
export function wrapBalance(balance: WiseBalance): WiseBalance {
  return {
    ...balance,
    name: wrapField(balance.name, BALANCE_SOURCE) ?? null,
  };
}

/**
 * Recipient names, account summaries, display values, and the free-form
 * `details` map (bank account numbers, IBANs, emails, references) are
 * recipient-authored. `details` keys are route-specific and Wise-generated
 * but not part of the connector contract, so the map is enveloped wholesale.
 */
export function wrapRecipient(recipient: WiseRecipient): WiseRecipient {
  return {
    ...recipient,
    name: recipient.name
      ? {
          fullName: wrapField(recipient.name.fullName, RECIPIENT_SOURCE),
          givenName: wrapField(recipient.name.givenName, RECIPIENT_SOURCE) ?? null,
          familyName: wrapField(recipient.name.familyName, RECIPIENT_SOURCE) ?? null,
        }
      : undefined,
    accountSummary: wrapField(recipient.accountSummary, RECIPIENT_SOURCE),
    longAccountSummary: wrapField(recipient.longAccountSummary, RECIPIENT_SOURCE),
    displayFields: recipient.displayFields?.map((field) => ({
      ...field,
      label: wrapField(field.label, RECIPIENT_SOURCE),
      value: wrapField(field.value, RECIPIENT_SOURCE),
    })),
    details: recipient.details
      ? wrapUntrustedJsonStrings(recipient.details, RECIPIENT_SOURCE)
      : undefined,
  };
}

/** Quote notices and vendor display strings are Wise-authored text. */
export function wrapQuote(quote: WiseQuote): WiseQuote {
  return {
    ...quote,
    paymentOptions: quote.paymentOptions?.map((option) => ({
      ...option,
      formattedEstimatedDelivery: wrapField(option.formattedEstimatedDelivery, QUOTE_SOURCE),
      disabledReason: option.disabledReason
        ? {
            code: option.disabledReason.code,
            message: wrapField(option.disabledReason.message, QUOTE_SOURCE),
          }
        : option.disabledReason,
    })),
    notices: quote.notices?.map((notice) => ({
      ...notice,
      text: wrapField(notice.text, QUOTE_SOURCE),
    })),
  };
}

/** The payment reference on a transfer is sender-authored free text. */
export function wrapTransfer(transfer: WiseTransfer): WiseTransfer {
  return {
    ...transfer,
    details: transfer.details
      ? { reference: wrapField(transfer.details.reference, TRANSFER_SOURCE) }
      : undefined,
  };
}

function wrapStatementTransaction(tx: WiseStatementTransaction): WiseStatementTransaction {
  return {
    ...tx,
    referenceNumber: wrapField(tx.referenceNumber, STATEMENT_SOURCE),
    details: tx.details
      ? {
          ...tx.details,
          description: wrapField(tx.details.description, STATEMENT_SOURCE),
          senderName: wrapField(tx.details.senderName, STATEMENT_SOURCE),
          senderAccount: wrapField(tx.details.senderAccount, STATEMENT_SOURCE),
          paymentReference: wrapField(tx.details.paymentReference, STATEMENT_SOURCE),
          category: wrapField(tx.details.category, STATEMENT_SOURCE),
          merchant: tx.details.merchant
            ? {
                ...tx.details.merchant,
                name: wrapField(tx.details.merchant.name, STATEMENT_SOURCE),
                firstLine: wrapField(tx.details.merchant.firstLine, STATEMENT_SOURCE),
                postCode: wrapField(tx.details.merchant.postCode, STATEMENT_SOURCE),
                city: wrapField(tx.details.merchant.city, STATEMENT_SOURCE),
                state: wrapField(tx.details.merchant.state, STATEMENT_SOURCE),
                country: wrapField(tx.details.merchant.country, STATEMENT_SOURCE),
                category: wrapField(tx.details.merchant.category, STATEMENT_SOURCE),
              }
            : undefined,
        }
      : undefined,
  };
}

/**
 * Statement rows carry counterparty-authored text (descriptions, sender
 * names, payment references, merchant details). `accountHolder`, `issuer`,
 * and `bankDetails` are account-holder / bank-authored blobs, enveloped
 * wholesale (keys included) since their shape is not part of the connector
 * contract.
 */
export function wrapStatement(statement: WiseStatement): WiseStatement {
  return {
    ...statement,
    accountHolder: statement.accountHolder
      ? wrapUntrustedJsonStrings(statement.accountHolder, STATEMENT_SOURCE)
      : undefined,
    issuer: statement.issuer
      ? wrapUntrustedJsonStrings(statement.issuer, STATEMENT_SOURCE)
      : undefined,
    bankDetails: statement.bankDetails
      ? wrapUntrustedJsonStrings(statement.bankDetails, STATEMENT_SOURCE)
      : statement.bankDetails,
    transactions: statement.transactions?.map(wrapStatementTransaction),
  };
}

/**
 * Activity titles and descriptions are Wise-authored display strings (titles
 * embed custom markup tags such as `<strong>`); formatted amount strings are
 * vendor-rendered text as well. Everything user-visible gets enveloped.
 */
export function wrapActivity(activity: WiseActivity): WiseActivity {
  return {
    ...activity,
    title: wrapField(activity.title, ACTIVITY_SOURCE),
    description: wrapField(activity.description, ACTIVITY_SOURCE),
    primaryAmount: wrapField(activity.primaryAmount, ACTIVITY_SOURCE),
    secondaryAmount: wrapField(activity.secondaryAmount, ACTIVITY_SOURCE),
  };
}

/** Deep-wrap arbitrary vendor payloads (e.g. requirement-group examples). */
export function wrapRequirementsPayload<T>(payload: T): T {
  return wrapValuesDeep(payload, RECIPIENT_SOURCE);
}
