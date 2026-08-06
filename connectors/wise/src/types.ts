/**
 * Default timeout (ms) for outbound HTTP requests made by this connector.
 * 30s is the safe baseline for CRUD / polling-style APIs.
 *
 * Users can override via the `WISE_REQUEST_TIMEOUT_MS` env var.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Sanity ceiling on configured timeouts. 30 minutes is well above any
 * realistic request latency and catches accidental extra zeros in env
 * values (e.g. pasting `1800000000` instead of `180000`).
 */
export const MAX_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Parse a positive integer from an env var. Returns the fallback (with a
 * stderr warning) for missing/empty, non-integer, non-positive, or
 * out-of-range values so misconfiguration is visible rather than silently
 * defaulting.
 */
export function parseTimeoutEnv(envVarName: string, fallbackMs: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw === '') return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.error(
      `[connector] Ignoring invalid ${envVarName}=${JSON.stringify(raw)} (expected positive integer ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  if (parsed > MAX_REQUEST_TIMEOUT_MS) {
    console.error(
      `[connector] Ignoring ${envVarName}=${parsed} (exceeds max ${MAX_REQUEST_TIMEOUT_MS}ms); using default ${fallbackMs}`,
    );
    return fallbackMs;
  }
  return parsed;
}

export function getRequestTimeoutMs(): number {
  return parseTimeoutEnv('WISE_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
}

export interface BridgeState {
  port: number;
  token: string;
}

export class WiseError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'WiseError';
  }
}

// ---------------------------------------------------------------------------
// Connector configuration
// ---------------------------------------------------------------------------

export type WiseEnvironment = 'production' | 'sandbox';

export interface WiseCredentials {
  apiToken: string;
  environment: WiseEnvironment;
  connectedAt?: string;
}

// ---------------------------------------------------------------------------
// Wise API types (response shapes per the Wise Platform API reference)
// ---------------------------------------------------------------------------

export interface WiseAmount {
  value: number;
  currency: string;
}

export interface WiseProfile {
  id: number;
  type: 'PERSONAL' | 'BUSINESS';
  publicId?: string;
  userId?: number;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  preferredName?: string;
  businessName?: string;
  dateOfBirth?: string;
  phoneNumber?: string;
  email?: string;
  currentState?: string;
  contactDetails?: { email?: string; phoneNumber?: string };
  address?: {
    id?: number;
    addressFirstLine?: string;
    city?: string;
    countryIso2Code?: string;
    countryIso3Code?: string;
    postCode?: string;
    stateCode?: string | null;
  };
}

export interface WiseBalance {
  id: number;
  currency: string;
  type: 'STANDARD' | 'SAVINGS';
  name?: string | null;
  investmentState?: string;
  amount: WiseAmount;
  reservedAmount?: WiseAmount;
  cashAmount?: WiseAmount;
  totalWorth?: WiseAmount;
  creationTime?: string;
  modificationTime?: string;
  visible?: boolean;
}

export interface WiseRate {
  rate: number;
  source: string;
  target: string;
  time: string;
}

export interface WiseRecipient {
  id: number;
  profileId?: number;
  creatorId?: number;
  name?: {
    fullName?: string;
    givenName?: string | null;
    familyName?: string | null;
  };
  currency?: string;
  country?: string;
  type?: string;
  legalEntityType?: string;
  active?: boolean;
  details?: Record<string, unknown>;
  accountSummary?: string;
  longAccountSummary?: string;
  displayFields?: Array<{ key?: string; label?: string; value?: string }>;
  ownedByCustomer?: boolean;
  hash?: string;
}

export interface WiseRecipientPage {
  content: WiseRecipient[];
  seekPositionForNext?: number | null;
  seekPositionForCurrent?: number | null;
  size?: number;
}

/** A requirement group as returned by the quote-scoped account-requirements API. */
export interface WiseRequirementGroup {
  type?: string;
  title?: string;
  usageInfo?: string | null;
  fields?: Array<{
    name?: string;
    group?: Array<{
      key?: string;
      name?: string;
      type?: string;
      refreshRequirementsOnChange?: boolean;
      required?: boolean;
      displayFormat?: string | null;
      example?: string;
      minLength?: number | null;
      maxLength?: number | null;
      validationRegexp?: string | null;
      valuesAllowed?: Array<{ key?: string; name?: string }> | null;
    }>;
  }>;
}

export interface WiseQuote {
  id: string;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount?: number;
  targetAmount?: number;
  payOut?: string;
  preferredPayIn?: string;
  rate?: number;
  rateType?: string;
  rateExpirationTime?: string;
  profile?: number;
  status?: string;
  expirationTime?: string;
  createdTime?: string;
  paymentOptions?: Array<{
    disabled?: boolean;
    estimatedDelivery?: string;
    formattedEstimatedDelivery?: string;
    fee?: {
      transferwise?: number;
      payIn?: number;
      discount?: number;
      partner?: number;
      total?: number;
    };
    sourceAmount?: number;
    targetAmount?: number;
    sourceCurrency?: string;
    targetCurrency?: string;
    payIn?: string;
    payOut?: string;
    feePercentage?: number;
    disabledReason?: { code?: string; message?: string } | null;
  }>;
  notices?: Array<{ text?: string; link?: string | null; type?: string }>;
}

export interface WiseTransfer {
  id: number;
  user?: number;
  targetAccount?: number;
  sourceAccount?: number | null;
  quote?: number | null;
  quoteUuid?: string;
  status?: string;
  rate?: number;
  created?: string;
  details?: { reference?: string };
  hasActiveIssues?: boolean;
  sourceCurrency?: string;
  sourceValue?: number;
  targetCurrency?: string;
  targetValue?: number;
  customerTransactionId?: string;
}

export interface WiseTransferPayment {
  type: string;
  status: 'COMPLETED' | 'REJECTED' | string;
  errorCode?: string | null;
}

export interface WiseStatementTransaction {
  type?: 'DEBIT' | 'CREDIT';
  date?: string;
  amount?: WiseAmount;
  totalFees?: WiseAmount;
  details?: {
    type?: string;
    description?: string;
    amount?: WiseAmount;
    senderName?: string;
    senderAccount?: string;
    paymentReference?: string;
    category?: string;
    merchant?: {
      name?: string;
      firstLine?: string;
      postCode?: string;
      city?: string;
      state?: string;
      country?: string;
      category?: string;
    };
    sourceAmount?: WiseAmount;
    targetAmount?: WiseAmount;
    fee?: number;
    rate?: number;
  };
  runningBalance?: WiseAmount;
  referenceNumber?: string;
}

export interface WiseStatement {
  accountHolder?: Record<string, unknown>;
  issuer?: Record<string, unknown>;
  bankDetails?: Record<string, unknown> | null;
  transactions?: WiseStatementTransaction[];
  endOfStatementBalance?: WiseAmount;
  query?: { intervalStart?: string; intervalEnd?: string; currency?: string; accountId?: number };
}

export interface WiseActivity {
  id?: string;
  type?: string;
  resource?: { type?: string; id?: string };
  title?: string;
  description?: string;
  primaryAmount?: string;
  secondaryAmount?: string;
  status?: string;
  createdOn?: string;
  updatedOn?: string;
}

export interface WiseActivitiesPage {
  cursor?: string | null;
  activities?: WiseActivity[];
}
