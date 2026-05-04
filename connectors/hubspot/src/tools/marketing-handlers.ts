import { getHubSpotClientAsync, HubSpotApiError } from '../api/hubspot-client.js';
import logger from '../utils/logger.js';

/**
 * Parse HubSpot API error for AI-friendly messages
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
    
    // Permission error - likely tier restriction or missing scope
    if (error.statusCode === 403) {
      // Check if error mentions missing scopes (HubSpot returns this in the message)
      const errorStr = JSON.stringify(details || message || '').toLowerCase();
      const isMissingScope = errorStr.includes('scope') || errorStr.includes('permission');
      
      if (context.feature === 'lists') {
        return {
          error: 'Lists API access denied - likely missing crm.lists.read scope',
          errorCode: 'SCOPE_MISSING',
          suggestion: 'If you connected HubSpot before Jan 2026, you need to reconnect to grant the new Lists scope. Go to Settings → Connectors → HubSpot → Disconnect, then reconnect.'
        };
      }
      if (context.feature === 'contacts' && context.operation === 'batch_read') {
        return {
          error: 'Contacts batch read access denied',
          errorCode: 'PERMISSION_DENIED',
          suggestion: 'Ensure crm.objects.contacts.read scope is granted. If using with Lists, you may need to reconnect HubSpot.'
        };
      }
      if (context.feature === 'analytics') {
        return {
          error: 'Analytics API requires Marketing Hub Professional or Enterprise',
          errorCode: 'MARKETING_HUB_REQUIRED',
          suggestion: 'This feature is only available on paid Marketing Hub plans. Check your HubSpot subscription.'
        };
      }
      if (context.feature === 'marketing_emails') {
        return {
          error: 'Marketing Emails API requires Marketing Hub',
          errorCode: 'MARKETING_HUB_REQUIRED',
          suggestion: 'This feature requires a Marketing Hub subscription.'
        };
      }
      // Generic 403 with scope hint
      if (isMissingScope) {
        return {
          error: 'HubSpot API scope or permission denied',
          errorCode: 'SCOPE_OR_PERMISSION_DENIED',
          suggestion: 'This may require reconnecting HubSpot to grant additional scopes, or upgrading your HubSpot subscription.'
        };
      }
      return {
        error: 'Insufficient HubSpot permissions for this operation',
        errorCode: 'PERMISSION_DENIED',
        suggestion: 'Check your HubSpot account permissions or subscription tier.'
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
      error: message,
      errorCode: 'API_ERROR',
      suggestion: 'Check the request parameters and try again.',
      details
    };
  }
  
  return {
    error: String(error),
    errorCode: 'UNKNOWN_ERROR',
    suggestion: 'An unexpected error occurred. Check HubSpot connection status.'
  };
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
  try {
    if (args.ids.length > 100) {
      throw new Error('Maximum 100 contact IDs per batch request. Split into multiple calls.');
    }
    
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
