import { getHubSpotClientAsync, HubSpotApiError } from '../api/hubspot-client.js';
import {
  buildHubSpotCapabilityDeniedError,
  parseHubSpotError as parseSharedHubSpotError,
  summariseHubSpotApiError,
  type ParsedHubSpotError,
} from '../utils/error-parser.js';
import logger from '../utils/logger.js';
import { assertMaxFanOut } from './input-limits.js';

/**
 * Parse HubSpot API error for AI-friendly messages
 */
function parseHubSpotError(
  error: unknown,
  context: { feature: string; operation: string; args?: unknown },
): ParsedHubSpotError {
  const sharedParsed = parseSharedHubSpotError(error, {
    objectType: context.feature,
    operation: context.operation,
    args: context.args,
  });
  if (
    'status' in sharedParsed ||
    sharedParsed.errorCode === 'REFRESH_TRANSIENT' ||
    sharedParsed.errorCode === 'REFRESH_RATE_LIMITED' ||
    sharedParsed.errorCode === 'REFRESH_MALFORMED_RESPONSE' ||
    sharedParsed.errorCode === 'REFRESH_LOCK_FAILED' ||
    sharedParsed.errorCode === 'TOKEN_PERSIST_FAILED'
  ) {
    return sharedParsed;
  }

  if (error instanceof HubSpotApiError) {
    // Permission error - likely tier restriction or missing scope
    if (error.statusCode === 403) {
      // Note: the Lists feature (crm.lists.read, a recently-added scope) is handled
      // by the generic branch below via the shared builder's recently-added-scope
      // hybrid — no bespoke branch needed.
      if (context.feature === 'contacts' && context.operation === 'batch_read') {
        const capabilityDenied = buildHubSpotCapabilityDeniedError({
          objectType: 'contacts',
          operation: context.operation,
          args: context.args,
        });
        return {
          error: capabilityDenied.error,
          errorCode: 'SCOPE_MISSING',
          suggestion: capabilityDenied.suggestion,
          details: summariseHubSpotApiError(error, { operation: context.operation }),
        };
      }
      if (
        context.feature === 'analytics' ||
        context.feature === 'marketing_emails' ||
        context.feature === 'marketing_email'
      ) {
        // Honest multi-cause copy (scope registration / plan / user permission),
        // not the old single-cause "requires Marketing Hub" that sent users in
        // circles reconnecting (FOX-3631). See error-parser helper.
        const capabilityDenied = buildHubSpotCapabilityDeniedError({
          objectType: context.feature,
          operation: context.operation,
          args: context.args,
        });
        return {
          error: capabilityDenied.error,
          errorCode: 'SCOPE_MISSING',
          suggestion: capabilityDenied.suggestion,
          details: summariseHubSpotApiError(error, { operation: context.operation }),
        };
      }
      // Generic 403 capability gap: honest multi-cause copy rather than
      // reconnect-first. Falls back to a neutral capability label for features
      // without a specific one.
      const capabilityDenied = buildHubSpotCapabilityDeniedError({
        objectType: context.feature,
        operation: context.operation,
        args: context.args,
      });
      return {
        error: capabilityDenied.error,
        errorCode: 'SCOPE_MISSING',
        suggestion: capabilityDenied.suggestion,
        details: summariseHubSpotApiError(error, { operation: context.operation }),
      };
    }
    
    // Authentication error
    if (error.statusCode === 401) {
      return {
        error: 'HubSpot authentication expired or invalid',
        errorCode: 'AUTH_EXPIRED',
        suggestion: 'Call list_hubspot_accounts to check status, then authenticate_hubspot_account to refresh.'
      };
    }
    
    // Not found
    if (error.statusCode === 404) {
      return {
        error: `${context.feature} not found`,
        errorCode: 'NOT_FOUND',
        suggestion: `Verify the ${context.feature} ID is correct.`
      };
    }
    
    return {
      error: 'HubSpot marketing API error',
      errorCode: 'API_ERROR',
      suggestion: 'Check the request parameters and try again.',
      details: summariseHubSpotApiError(error, { operation: context.operation })
    };
  }

  return sharedParsed.errorCode === 'UNKNOWN_ERROR'
    ? {
      error: 'Unexpected HubSpot marketing error',
      errorCode: 'UNKNOWN_ERROR',
      suggestion: 'An unexpected error occurred. Check HubSpot connection status.'
    }
    : sharedParsed;
}

// ===============================
// Forms Handlers
// ===============================

export async function handleListForms(args: { formTypes?: string[]; limit?: number; after?: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.listForms(args.limit || 20, args.after, args.formTypes);
    
    logger.info(`Listed ${result.results.length} forms`);
    return {
      forms: result.results,
      paging: result.paging
    };
  } catch (error) {
    const parsed = parseHubSpotError(error, { feature: 'forms', operation: 'list', args });
    logger.error(`List forms failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetForm(args: { formId: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getForm(args.formId);
    
    logger.info(`Retrieved form ${args.formId}: ${result.name}`);
    return result;
  } catch (error) {
    const parsed = parseHubSpotError(error, { feature: 'form', operation: 'get', args });
    logger.error(`Get form failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetFormSubmissions(args: { formId: string; limit?: number; after?: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getFormSubmissions(args.formId, args.limit || 20, args.after);
    
    logger.info(`Retrieved ${result.results.length} submissions for form ${args.formId}`);
    return {
      submissions: result.results,
      paging: result.paging
    };
  } catch (error) {
    const parsed = parseHubSpotError(error, { feature: 'form_submissions', operation: 'get', args });
    logger.error(`Get form submissions failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// ===============================
// Analytics Handlers
// ===============================

export async function handleGetAnalyticsReport(args: {
  breakdownBy: string;
  timePeriod: string;
  startDate: string;
  endDate: string;
  limit?: number;
}) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getAnalyticsReport(
      args.breakdownBy,
      args.timePeriod,
      args.startDate,
      args.endDate,
      args.limit || 100
    );
    
    logger.info(`Retrieved analytics report: ${args.breakdownBy}/${args.timePeriod} from ${args.startDate} to ${args.endDate}`);
    return result;
  } catch (error) {
    const parsed = parseHubSpotError(error, { feature: 'analytics', operation: 'get_report', args });
    logger.error(`Get analytics report failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// ===============================
// Marketing Email Handlers
// ===============================

export async function handleListMarketingEmails(args: { limit?: number; after?: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.listMarketingEmails(args.limit || 20, args.after);
    
    logger.info(`Listed ${result.results.length} marketing emails`);
    return {
      emails: result.results,
      paging: result.paging
    };
  } catch (error) {
    const parsed = parseHubSpotError(error, { feature: 'marketing_emails', operation: 'list', args });
    logger.error(`List marketing emails failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetMarketingEmail(args: { emailId: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getMarketingEmail(args.emailId);
    
    logger.info(`Retrieved marketing email ${args.emailId}: ${result.name}`);
    return result;
  } catch (error) {
    const parsed = parseHubSpotError(error, { feature: 'marketing_email', operation: 'get', args });
    logger.error(`Get marketing email failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetEmailStatistics(args: {
  startTimestamp?: string;
  endTimestamp?: string;
  emailIds?: string[];
}) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getEmailStatistics(
      args.startTimestamp,
      args.endTimestamp,
      args.emailIds
    );
    
    logger.info(`Retrieved email statistics${args.emailIds ? ` for ${args.emailIds.length} emails` : ''}`);
    return result;
  } catch (error) {
    const parsed = parseHubSpotError(error, { feature: 'marketing_emails', operation: 'get_statistics', args });
    logger.error(`Get email statistics failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// ============================================================================
// LISTS/SEGMENTS HANDLERS
// ============================================================================

export async function handleListLists(args: { limit?: number; after?: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.listLists(args.limit || 20, args.after);
    
    logger.info(`Listed ${result.results.length} lists/segments`);
    return {
      lists: result.results,
      paging: result.paging
    };
  } catch (error) {
    const parsed = parseHubSpotError(error, { feature: 'lists', operation: 'list', args });
    logger.error(`List lists failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetList(args: { listId: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getList(args.listId);
    
    logger.info(`Retrieved list ${args.listId}: ${result.name}`);
    return result;
  } catch (error) {
    const parsed = parseHubSpotError(error, { feature: 'lists', operation: 'get', args });
    logger.error(`Get list failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleListListMembers(args: { listId: string; limit?: number; after?: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getListMembers(args.listId, args.limit || 100, args.after);
    
    logger.info(`Retrieved ${result.results.length} members from list ${args.listId}`);
    return {
      members: result.results,
      paging: result.paging
    };
  } catch (error) {
    const parsed = parseHubSpotError(error, { feature: 'lists', operation: 'get_members', args });
    logger.error(`Get list members failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleBatchReadContacts(args: { ids: string[]; properties?: string[] }) {
  assertMaxFanOut(args.ids, 'ids');

  try {
    const client = await getHubSpotClientAsync();
    const result = await client.batchReadContacts(args.ids, args.properties);
    
    logger.info(`Batch read ${result.results.length} contacts`);
    return {
      contacts: result.results
    };
  } catch (error) {
    const parsed = parseHubSpotError(error, { feature: 'contacts', operation: 'batch_read', args });
    logger.error(`Batch read contacts failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}
