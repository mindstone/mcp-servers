import { HubSpotApiError, HubSpotAuthRequiredError } from '../api/hubspot-client.js';
import {
  RefreshMalformedResponseError,
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
  details?: unknown;
}

export interface ParsedAuthRequiredResponse {
  status: 'auth_required';
  user_action: { id: 'hubspot.connect_account' };
  agent_action: {
    instruction:
      'Tell the user that HubSpot needs reauthentication. The host will open the OAuth flow in their browser; once complete, retry the original request.';
  };
  setupToolName: 'authenticate_hubspot_account';
}

export type ParsedHubSpotError = ParsedStructuredHubSpotError | ParsedAuthRequiredResponse;

function buildAuthRequiredResponse(): ParsedAuthRequiredResponse {
  return {
    status: 'auth_required',
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
      details: {
        retry_after: error.retryAfterSeconds
      }
    };
  }

  if (error instanceof RefreshMalformedResponseError) {
    return {
      error: 'HubSpot returned a malformed token refresh response',
      errorCode: 'REFRESH_MALFORMED_RESPONSE',
      suggestion: 'Retry the request. If this persists, reconnect HubSpot.'
    };
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
        suggestion: 'Wait a moment and retry. If this persists, reduce request frequency or batch operations.'
      };
    }

    if (error.statusCode === 400 || error.statusCode === 422 || category === 'VALIDATION_ERROR') {
      if (message.includes('Property values were not valid')) {
        const propertyErrors = details?.errors as Array<{ context?: { propertyName?: string[] } }> | undefined;
        const invalidProps = propertyErrors
          ?.map(propertyError => propertyError.context?.propertyName?.[0])
          .filter(Boolean) || [];

        return {
          error: invalidProps.length > 0
            ? `Invalid property values for: ${invalidProps.join(', ')}`
            : `Validation failed: ${message}`,
          errorCode: 'VALIDATION_ERROR',
          suggestion: 'Check required fields, allowed enum values, and data formats before retrying.',
          details: details?.errors || details
        };
      }

      return {
        error: `Validation failed: ${message}`,
        errorCode: 'VALIDATION_ERROR',
        suggestion: 'Check required fields, allowed values, and expected formats in your request.',
        details
      };
    }

    return {
      error: `HubSpot API error: ${message}`,
      errorCode: 'API_ERROR',
      suggestion: 'Check your inputs and try again.',
      details: error.details
    };
  }

  return {
    error: error instanceof Error ? error.message : 'Unknown error',
    errorCode: 'UNKNOWN_ERROR',
    suggestion: 'Check HubSpot connection with list_hubspot_accounts and try again.'
  };
}
