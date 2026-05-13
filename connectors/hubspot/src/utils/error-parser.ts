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

  return compactSummary({
    operation: context?.operation,
    statusCode,
    errorCode: safeIdentifier(details?.errorCode) || safeIdentifier(details?.code) || safeIdentifier(details?.error),
    category: safeIdentifier(details?.category),
    requestId,
    retryAfterSeconds,
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
      return {
        error: `Insufficient HubSpot scopes or permissions for ${context.operation} on ${objectType}`,
        errorCode: 'SCOPE_MISSING',
        suggestion: 'Reconnect HubSpot and grant the required scopes. If this is a paid feature, verify your HubSpot plan includes it.'
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
