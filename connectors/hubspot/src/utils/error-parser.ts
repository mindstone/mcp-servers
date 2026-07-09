import { HubSpotApiError, HubSpotAuthRequiredError } from '../api/hubspot-client.js';
import {
  RefreshMalformedResponseError,
  RefreshNoClientCredsError,
  RefreshRateLimitedError,
  RefreshTransientError,
} from '../modules/accounts/oauth.js';
import { TokenPersistFailedError } from '../modules/accounts/manager.js';
import { RefreshLockFailedError } from './credentialLock.js';

export interface HubSpotErrorContext {
  objectType?: string;
  operation: string;
  args?: unknown;
}

export interface ParsedStructuredHubSpotError {
  error: string;
  errorCode: string;
  suggestion: string;
  details?: HubSpotApiErrorSummary;
  invalidProperties?: string[];
  retryAfterSeconds?: number;
}

export interface ParsedAuthRequiredResponse {
  status: 'auth_required';
  errorCode?: string;
  user_action: { id: 'hubspot.connect_account' };
  agent_action: {
    instruction:
      'Tell the user that HubSpot needs reauthentication. The host will open the OAuth flow in their browser; once complete, retry the original request.';
  };
  setupToolName: 'authenticate_hubspot_account';
}

export type ParsedHubSpotError = ParsedStructuredHubSpotError | ParsedAuthRequiredResponse;

export interface HubSpotApiErrorSummary {
  operation?: string;
  statusCode?: number;
  errorCode?: string;
  category?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  /** Scope(s) HubSpot named as missing on a 403 — surfaced for diagnosis/telemetry. */
  requiredScopes?: string[];
}

function compactSummary(summary: HubSpotApiErrorSummary): HubSpotApiErrorSummary {
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined),
  ) as HubSpotApiErrorSummary;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) return undefined;
  return value;
}

function safeRetryAfterSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return Math.floor(value);
}

function getNestedRecord(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return asRecord(record?.[key]);
}

function extractRequestIdFromDetails(details: Record<string, unknown> | undefined): string | undefined {
  return safeIdentifier(
    details?.correlationId ||
    details?.requestId ||
    details?.request_id ||
    details?.['x-hubspot-correlation-id'] ||
    details?.['x-request-id']
  );
}

function extractInvalidProperties(details: Record<string, unknown> | undefined): string[] {
  const errors = Array.isArray(details?.errors) ? details.errors : [];
  const propertyNames = new Set<string>();

  const addPropertyName = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const safe = safeIdentifier(item);
        if (safe) propertyNames.add(safe);
      }
      return;
    }

    const safe = safeIdentifier(value);
    if (safe) propertyNames.add(safe);
  };

  for (const item of errors) {
    const itemRecord = asRecord(item);
    addPropertyName(itemRecord?.propertyName);
    addPropertyName(asRecord(itemRecord?.context)?.propertyName);
  }

  return [...propertyNames];
}

export function summariseHubSpotApiError(
  error: unknown,
  context?: { operation?: string },
): HubSpotApiErrorSummary {
  const record = asRecord(error);
  const details = error instanceof HubSpotApiError
    ? asRecord(error.details)
    : asRecord(record?.details) ||
      asRecord(record?.body) ||
      asRecord(getNestedRecord(record, 'response')?.data);

  const statusCode = error instanceof HubSpotApiError
    ? error.statusCode
    : typeof record?.statusCode === 'number'
      ? record.statusCode
      : typeof record?.status === 'number'
        ? record.status
        : undefined;

  const requestId = error instanceof HubSpotApiError
    ? safeIdentifier(error.requestId) || extractRequestIdFromDetails(details)
    : safeIdentifier(record?.requestId) ||
      safeIdentifier(record?.['x-hubspot-correlation-id']) ||
      extractRequestIdFromDetails(details);

  const retryAfterSeconds = error instanceof HubSpotApiError
    ? safeRetryAfterSeconds(error.retryAfterSeconds)
    : safeRetryAfterSeconds(record?.retryAfterSeconds);

  // Required scopes are a 403 (MISSING_SCOPES) concept. Only extract them there,
  // so identifier-shaped values in other bodies (e.g. validation errors) can't
  // land in the scope field.
  const requiredScopes = statusCode === 403 ? extractRequiredScopes(details) : [];

  return compactSummary({
    operation: context?.operation,
    statusCode,
    errorCode: safeIdentifier(details?.errorCode) || safeIdentifier(details?.code) || safeIdentifier(details?.error),
    category: safeIdentifier(details?.category),
    requestId,
    retryAfterSeconds,
    requiredScopes: requiredScopes.length > 0 ? requiredScopes : undefined,
  });
}

const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNRESET',
]);

function classifyNonApiError(error: unknown): 'REQUEST_TIMEOUT' | 'NETWORK_ERROR' | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const record = error as Record<string, unknown>;
  const causeRecord = asRecord(record.cause);
  const code = typeof record.code === 'string'
    ? record.code
    : typeof causeRecord?.code === 'string'
      ? causeRecord.code
      : undefined;
  const name = typeof record.name === 'string' ? record.name : undefined;

  if (name === 'AbortError' || code === 'ABORT_ERR') {
    return 'REQUEST_TIMEOUT';
  }

  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code.toUpperCase())) {
    return 'NETWORK_ERROR';
  }

  if (typeof record.message === 'string' && record.message.toLowerCase().includes('fetch failed')) {
    return 'NETWORK_ERROR';
  }

  return undefined;
}

function buildAuthRequiredResponse(errorCode?: string): ParsedAuthRequiredResponse {
  return {
    status: 'auth_required',
    ...(errorCode ? { errorCode } : {}),
    user_action: { id: 'hubspot.connect_account' },
    agent_action: {
      instruction:
        'Tell the user that HubSpot needs reauthentication. The host will open the OAuth flow in their browser; once complete, retry the original request.'
    },
    setupToolName: 'authenticate_hubspot_account'
  };
}

const HUBSPOT_CAPABILITY_LABELS: Record<string, string> = {
  contacts: 'contacts',
  companies: 'companies',
  deals: 'deals',
  lists: 'lists',
  tickets: 'support tickets (Service Hub)',
  products: 'products',
  line_items: 'line items',
  leads: 'leads',
  tasks: 'tasks',
  files: 'files and attachments',
  calls: 'calls',
  emails: 'emails',
  meetings: 'meetings',
  notes: 'notes',
  owners: 'owners',
  associations: 'record associations',
  marketing_emails: 'marketing emails (Marketing Hub)',
  marketing_email: 'marketing emails (Marketing Hub)',
  analytics: 'marketing analytics (Marketing Hub)',
  workflows: 'workflows and automation',
  automation: 'workflows and automation',
  knowledge_base_articles: 'the knowledge base (Service Hub)',
  conversations: 'the conversations inbox',
};

// Capabilities that map to a HubSpot *plan* (paid hub) rather than a per-object
// scope. Used to give the plan-specific hint in the capability-denied copy.
const HUBSPOT_PLAN_HINTS: Record<string, string> = {
  tickets: 'support tickets require Service Hub, for example',
  marketing_emails: 'marketing emails require a paid Marketing Hub plan, for example',
  marketing_email: 'marketing emails require a paid Marketing Hub plan, for example',
  analytics: 'marketing analytics requires a paid Marketing Hub plan, for example',
  workflows: 'workflows require Operations Hub or Marketing/Sales Hub Professional, for example',
  automation: 'workflows require Operations Hub or Marketing/Sales Hub Professional, for example',
  knowledge_base_articles: 'the knowledge base requires Service Hub Professional or Enterprise, for example',
};

// Capabilities whose OAuth scope was genuinely ADDED to the app at a known date.
// An account connected before then really does need to reconnect to grant the
// scope — so for these, reconnect legitimately leads. But we still name the
// plan/permission fallback so an already-reconnected account doesn't loop on an
// ineffective reconnect (the FOX-3631 failure mode, which the honest copy exists
// to prevent). Keyed by objectType; the value is the month the scope was added.
const HUBSPOT_RECENTLY_ADDED_SCOPE_HINTS: Record<string, string> = {
  lists: 'January 2026',
  conversations: 'May 2026',
};

/**
 * HubSpot returns the scope(s) it wanted on a 403 in the error body, under a few
 * shapes depending on API version. Pull whatever is present (validated), so the
 * missing scope is captured in structured error details / logs and a future
 * scope-gap is self-diagnosing rather than a guess. Never fabricates a scope.
 */
function extractRequiredScopes(details: Record<string, unknown> | undefined): string[] {
  const scopes = new Set<string>();
  const collect = (value: unknown): void => {
    // HubSpot usually returns an array, but tolerate a single scope string too.
    const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    for (const item of items) {
      const safe = safeIdentifier(item);
      if (safe) scopes.add(safe);
    }
  };

  // A scope may sit under `context` or directly on a record, at the top level
  // or inside each `errors[]` item — HubSpot varies by API version.
  const collectFrom = (record: Record<string, unknown> | undefined): void => {
    const context = getNestedRecord(record, 'context');
    collect(context?.requiredGranularScopes);
    collect(context?.requiredScopes);
    collect(record?.requiredGranularScopes);
    collect(record?.requiredScopes);
  };

  collectFrom(details);
  // HubSpot also nests contextual fields under errors[].context — the same shape
  // this connector already reads for validation propertyName (extractInvalidProperties).
  const errors = Array.isArray(details?.errors) ? details.errors : [];
  for (const item of errors) {
    collectFrom(asRecord(item));
  }

  return [...scopes];
}

export function describeHubSpotCapability(context: HubSpotErrorContext): string {
  const objectType = context.objectType?.trim().toLowerCase();
  if (objectType && HUBSPOT_CAPABILITY_LABELS[objectType]) {
    return HUBSPOT_CAPABILITY_LABELS[objectType];
  }

  return 'this HubSpot capability';
}

// Honest, multi-cause 403 copy shared by every capability-denied site (CRM,
// files, marketing, workflow). A HubSpot optional scope can be absent for three
// reasons, and none is fixed by reconnecting *alone* — so we name all three and
// present reconnect only as the final step once the real cause is resolved.
export function buildHubSpotCapabilityDeniedError(
  context: HubSpotErrorContext,
): { error: string; suggestion: string } {
  const key = context.objectType?.trim().toLowerCase() ?? '';
  const label = describeHubSpotCapability(context);
  const planHint = HUBSPOT_PLAN_HINTS[key];
  const planExample = planHint ? ` (${planHint})` : '';

  // Recently-added scope: reconnect legitimately leads for the pre-add cohort,
  // then the honest plan/permission fallback so a reconnected account doesn't loop.
  const scopeAddedMonth = HUBSPOT_RECENTLY_ADDED_SCOPE_HINTS[key];
  if (scopeAddedMonth) {
    return {
      error: `Can't access ${label} on this HubSpot connection.`,
      suggestion: `If you connected HubSpot before ${scopeAddedMonth}, reconnect to grant this — the scope for ${label} was added to the app then, so older connections don't have it yet. If you have reconnected since, reconnecting again won't add ${label} on its own: the account's plan may not include it${planExample}, the signed-in HubSpot user may not have permission for it, or (less commonly) a HubSpot administrator may need to authorise ${label} for the app. Other HubSpot features are unaffected.`,
    };
  }

  return {
    error: `Can't access ${label} on this HubSpot connection.`,
    suggestion: `This capability isn't available on the connected HubSpot account, and reconnecting won't add it on its own. Most often the account's plan may not include it${planExample}, or the signed-in HubSpot user may not have permission for it; less commonly, a HubSpot administrator may need to authorise ${label} for the app. Once the underlying cause is resolved, reconnect HubSpot to pick up the change. Other HubSpot features are unaffected.`,
  };
}

/**
 * Parse HubSpot API error into AI-friendly structured error payload.
 */
export function parseHubSpotError(error: unknown, context: HubSpotErrorContext): ParsedHubSpotError {
  if (error instanceof HubSpotAuthRequiredError) {
    return buildAuthRequiredResponse();
  }

  if (error instanceof TokenPersistFailedError) {
    return {
      error: 'Failed to persist refreshed HubSpot credentials',
      errorCode: 'TOKEN_PERSIST_FAILED',
      suggestion: 'Reconnect HubSpot and retry. If this persists, verify filesystem permissions for the HubSpot config directory.'
    };
  }

  if (error instanceof RefreshRateLimitedError) {
    return {
      error: 'HubSpot token refresh is rate limited',
      errorCode: 'REFRESH_RATE_LIMITED',
      suggestion: 'Retry after the indicated backoff window.',
      retryAfterSeconds: error.retryAfterSeconds
    };
  }

  if (error instanceof RefreshMalformedResponseError) {
    return {
      error: 'HubSpot returned a malformed token refresh response',
      errorCode: 'REFRESH_MALFORMED_RESPONSE',
      suggestion: 'Retry the request. If this persists, reconnect HubSpot.'
    };
  }

  if (error instanceof RefreshNoClientCredsError) {
    return buildAuthRequiredResponse(error.code);
  }

  if (error instanceof RefreshTransientError) {
    return {
      error: 'HubSpot token refresh failed temporarily',
      errorCode: 'REFRESH_TRANSIENT',
      suggestion: 'Retry in a moment. If failures continue, reconnect HubSpot.'
    };
  }

  if (error instanceof RefreshLockFailedError) {
    return {
      error: 'HubSpot credential lock is busy',
      errorCode: 'REFRESH_LOCK_FAILED',
      suggestion: 'Retry shortly. If this persists, reconnect HubSpot.'
    };
  }

  if (error instanceof HubSpotApiError) {
    const details = error.details as Record<string, unknown> | undefined;
    const message = (details?.message as string) || error.message;
    const category = details?.category as string | undefined;
    const objectType = context.objectType || 'resource';
    const apiErrorSummary = summariseHubSpotApiError(error, { operation: context.operation });

    if (error.statusCode === 401) {
      return {
        error: 'HubSpot authentication expired or invalid',
        errorCode: 'AUTH_EXPIRED',
        suggestion: 'Call list_hubspot_accounts to check status, then authenticate_hubspot_account to refresh.'
      };
    }

    if (error.statusCode === 403) {
      const capabilityDenied = buildHubSpotCapabilityDeniedError(context);

      return {
        error: capabilityDenied.error,
        errorCode: 'SCOPE_MISSING',
        suggestion: capabilityDenied.suggestion,
        // Carries category (e.g. MISSING_SCOPES), requestId, and any scope(s)
        // HubSpot named — so a scope-gap is diagnosable from logs, not a guess.
        details: apiErrorSummary
      };
    }

    if (error.statusCode === 404) {
      return {
        error: `${objectType} not found`,
        errorCode: 'NOT_FOUND',
        suggestion: `The requested ${objectType} could not be found. Verify the identifiers and try again.`
      };
    }

    if (error.statusCode === 429) {
      return {
        error: 'HubSpot API rate limit exceeded',
        errorCode: 'RATE_LIMITED',
        suggestion: 'Wait a moment and retry. If this persists, reduce request frequency or batch operations.',
        details: apiErrorSummary
      };
    }

    if (error.statusCode === 400 || error.statusCode === 422 || category === 'VALIDATION_ERROR') {
      if (message.includes('Property values were not valid')) {
        const invalidProps = extractInvalidProperties(details);

        return {
          error: invalidProps.length > 0
            ? `Invalid property values for: ${invalidProps.join(', ')}`
            : 'HubSpot rejected one or more property values',
          errorCode: 'VALIDATION_ERROR',
          suggestion: 'Check required fields, allowed enum values, and data formats before retrying.',
          invalidProperties: invalidProps,
          details: apiErrorSummary
        };
      }

      return {
        error: 'HubSpot validation failed',
        errorCode: 'VALIDATION_ERROR',
        suggestion: 'Check required fields, allowed values, and expected formats in your request.',
        details: apiErrorSummary
      };
    }

    return {
      error: 'HubSpot API error',
      errorCode: 'API_ERROR',
      suggestion: 'Check your inputs and try again.',
      details: apiErrorSummary
    };
  }

  const nonApiClassification = classifyNonApiError(error);
  if (nonApiClassification === 'REQUEST_TIMEOUT') {
    return {
      error: 'HubSpot request timed out',
      errorCode: 'REQUEST_TIMEOUT',
      suggestion: 'The request timed out. Retry in a moment.'
    };
  }

  if (nonApiClassification === 'NETWORK_ERROR') {
    return {
      error: 'Network error while contacting HubSpot',
      errorCode: 'NETWORK_ERROR',
      suggestion: 'Network unavailable; retry in a moment.'
    };
  }

  return {
    error: 'Unknown error',
    errorCode: 'UNKNOWN_ERROR',
    suggestion: 'Check HubSpot connection with list_hubspot_accounts and try again.'
  };
}
