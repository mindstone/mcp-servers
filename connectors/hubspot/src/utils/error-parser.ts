import { HubSpotApiError } from '../api/hubspot-client.js';

export interface HubSpotErrorContext {
  objectType?: string;
  operation: string;
  args?: unknown;
}

export interface ParsedHubSpotError {
  error: string;
  errorCode: string;
  suggestion: string;
  details?: unknown;
}

/**
 * Parse HubSpot API error into AI-friendly structured error payload.
 */
export function parseHubSpotError(error: unknown, context: HubSpotErrorContext): ParsedHubSpotError {
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
