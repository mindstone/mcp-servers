import { getHubSpotClientAsync, HubSpotApiError } from '../api/hubspot-client.js';
import logger from '../utils/logger.js';

/**
 * Parse HubSpot API error for AI-friendly messages (v4 Associations)
 */
function parseHubSpotError(error: unknown, context: { feature: string; operation: string; args?: unknown }): {
  error: string;
  errorCode: string;
  suggestion: string;
  details?: unknown;
} {
  if (error instanceof HubSpotApiError) {
    const details = error.details as Record<string, unknown> | undefined;
    const message = details?.message as string || error.message;

    if (error.statusCode === 401) {
      return {
        error: 'HubSpot authentication expired or invalid',
        errorCode: 'AUTH_EXPIRED',
        suggestion: 'Call list_hubspot_accounts to check status, then authenticate_hubspot_account to refresh.'
      };
    }
    if (error.statusCode === 403) {
      return {
        error: 'Association labels API access denied',
        errorCode: 'PERMISSION_DENIED',
        suggestion: 'Ensure your HubSpot account has CRM write scopes. Reconnect HubSpot if needed.'
      };
    }
    if (error.statusCode === 404) {
      const isListLabels = context.operation === 'list_labels';
      return {
        error: isListLabels
          ? `No association labels found for this object pair: ${message}`
          : `Association not found: ${message}`,
        errorCode: 'NOT_FOUND',
        suggestion: isListLabels
          ? 'Verify the object type names are correct (e.g., "contacts", "companies", "deals", "tickets"). Not all object pairs have association labels.'
          : 'Verify the object type names (e.g., "contacts", "deals") and record IDs are correct.'
      };
    }
    if (error.statusCode === 429) {
      return {
        error: 'HubSpot API rate limit exceeded',
        errorCode: 'RATE_LIMITED',
        suggestion: 'Wait a moment and try again. HubSpot limits API calls per second.'
      };
    }

    return {
      error: `Association API error: ${message}`,
      errorCode: 'API_ERROR',
      suggestion: 'Check your inputs and try again.',
      details: error.details
    };
  }

  return {
    error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    errorCode: 'UNKNOWN_ERROR',
    suggestion: 'Check your HubSpot connection and try again.'
  };
}

export async function handleListAssociationLabels(args: {
  fromObjectType: string;
  toObjectType: string;
}): Promise<unknown> {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.listAssociationLabels(args.fromObjectType, args.toObjectType);
    return { labels: result.results };
  } catch (error) {
    logger.error('Failed to list association labels', { args, error });
    const parsed = parseHubSpotError(error, {
      feature: 'associations_v4',
      operation: 'list_labels',
      args
    });
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleCreateLabeledAssociation(args: {
  fromObjectType: string;
  fromObjectId: string;
  toObjectType: string;
  toObjectId: string;
  associationCategory: 'HUBSPOT_DEFINED' | 'USER_DEFINED';
  associationTypeId: number;
}): Promise<unknown> {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.createLabeledAssociation(
      args.fromObjectType,
      args.fromObjectId,
      args.toObjectType,
      args.toObjectId,
      [{
        associationCategory: args.associationCategory,
        associationTypeId: args.associationTypeId
      }]
    );
    return {
      success: true,
      message: `Labeled association created between ${args.fromObjectType}/${args.fromObjectId} and ${args.toObjectType}/${args.toObjectId}`,
      result
    };
  } catch (error) {
    logger.error('Failed to create labeled association', { args, error });
    const parsed = parseHubSpotError(error, {
      feature: 'associations_v4',
      operation: 'create_labeled',
      args
    });
    throw new Error(JSON.stringify(parsed));
  }
}
