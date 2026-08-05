import { getHubSpotClientAsync, SearchFilter, SearchRequest, HubSpotApiError, assertHubSpotObjectType } from '../api/hubspot-client.js';
import { injectHostMetadata } from '../utils/user-context.js';
import {
  buildHubSpotCapabilityDeniedError,
  parseHubSpotError as parseSharedHubSpotError,
  summariseHubSpotApiError,
  type ParsedHubSpotError,
} from '../utils/error-parser.js';
import logger from '../utils/logger.js';
import {
  PROPERTY_SCHEMA_LITERAL_KEYS,
  sanitizeHubSpotResponse,
} from '../sanitize.js';
import {
  assertAssociationFanOut,
  assertRecordStringBodySizes,
} from './input-limits.js';
import {
  attachPropertyValidation,
  validateRequestedProperties,
} from './property-validation.js';

interface SearchArgs {
  query?: string;
  filters?: SearchFilter[];
  properties?: string[];
  limit?: number;
  after?: string;
}

interface GetArgs {
  properties?: string[];
  associations?: string[];
}

interface CreateArgs {
  properties: Record<string, string>;
}

interface UpdateArgs {
  properties: Record<string, string>;
}

interface NoteCreateArgs {
  properties: Record<string, string>;
  associations?: {
    contactIds?: string[];
    companyIds?: string[];
    dealIds?: string[];
    ticketIds?: string[];
  };
}

// Map object types to their primary searchable text fields
const SEARCHABLE_TEXT_FIELDS: Record<string, string[]> = {
  contacts: ['firstname', 'lastname', 'email'],
  companies: ['name', 'domain'],
  deals: ['dealname'],
  tickets: ['subject', 'content'],
  leads: ['hs_lead_name'],
  tasks: ['hs_task_subject', 'hs_task_body'],
  notes: ['hs_note_body'],
  products: ['name', 'hs_sku'],
  line_items: ['name']
};

/**
 * Parse HubSpot API error for AI-friendly messages
 */
function parseHubSpotError(
  error: unknown,
  context: { objectType: string; operation: string; args?: unknown },
): ParsedHubSpotError {
  const sharedParsed = parseSharedHubSpotError(error, context);
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
    const details = error.details as Record<string, unknown> | undefined;
    const message = details?.message as string || error.message;
    const category = details?.category as string;
    
    // Property validation error
    if (category === 'VALIDATION_ERROR' || error.statusCode === 400) {
      // Check for invalid property values
      if (message.includes('Property values were not valid')) {
        const propertyErrors = details?.errors as Array<{ context?: { propertyName?: string[] | string } }> || [];
        const invalidProps = [...new Set(propertyErrors.flatMap((propertyError) => {
          const propertyName = propertyError.context?.propertyName;
          if (Array.isArray(propertyName)) return propertyName;
          return typeof propertyName === 'string' ? [propertyName] : [];
        }).filter((propertyName): propertyName is string => propertyName.length > 0))];
        return {
          error: invalidProps.length > 0
            ? `Invalid property values for: ${invalidProps.join(', ')}`
            : 'HubSpot rejected one or more property values',
          errorCode: 'INVALID_PROPERTY_VALUE',
          suggestion: `Check the allowed values for these properties using list_hubspot_properties for ${context.objectType}. Common issues: 'industry' requires specific enum values, dates need ISO format.`,
          invalidProperties: invalidProps,
          details: summariseHubSpotApiError(error, { operation: context.operation })
        };
      }
      
      // Check for invalid filter/search
      if (message.includes('problem with the request')) {
        return {
          error: `Search request failed - likely invalid filter syntax or unsearchable property`,
          errorCode: 'INVALID_SEARCH_REQUEST',
          suggestion: `Use filters with valid operators (EQ, NEQ, CONTAINS_TOKEN, IN, GT, LT, etc.) on searchable properties. For text search, omit 'query' and use filters on specific properties like 'dealname', 'email', or 'name'.`,
          details: summariseHubSpotApiError(error, { operation: context.operation })
        };
      }
      
      return {
        error: 'HubSpot validation failed',
        errorCode: 'VALIDATION_ERROR',
        suggestion: 'Check that all required properties are provided and values match expected formats.',
        details: summariseHubSpotApiError(error, { operation: context.operation })
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
    
    // Permission error
    if (error.statusCode === 403) {
      const capabilityDenied = buildHubSpotCapabilityDeniedError(context);

      return {
        error: capabilityDenied.error,
        errorCode: 'PERMISSION_DENIED',
        suggestion: capabilityDenied.suggestion,
        // Carries any scope(s) HubSpot named (requiredScopes) for log-based diagnosis.
        details: summariseHubSpotApiError(error, { operation: context.operation })
      };
    }
    
    // Not found
    if (error.statusCode === 404) {
      return {
        error: `${context.objectType} not found`,
        errorCode: 'NOT_FOUND',
        suggestion: `The ${context.objectType} ID does not exist. Verify the ID is correct using search first.`
      };
    }
    
    // Rate limit
    if (error.statusCode === 429) {
      return {
        error: 'HubSpot API rate limit exceeded',
        errorCode: 'RATE_LIMITED',
        suggestion: 'Wait a few seconds before retrying. Consider batching operations.'
      };
    }
    
    // Server error
    if (error.statusCode >= 500) {
      return {
        error: 'HubSpot service temporarily unavailable',
        errorCode: 'SERVICE_ERROR',
        suggestion: 'HubSpot is experiencing issues. Retry in a few minutes.'
      };
    }
  }

  return sharedParsed;
}

// Generic search handler with improved query support
async function searchObjects(objectType: string, args: SearchArgs) {
  try {
    // Structural requirement: acquire the HubSpot client inside try/catch so
    // refresh-path auth errors are mapped via parseHubSpotError() and surface
    // as contractual auth_required responses (not UNKNOWN_ERROR).
    const client = await getHubSpotClientAsync();
    const searchRequest: SearchRequest = {
      limit: args.limit || 10,
      properties: args.properties,
      after: args.after
    };

    // Add explicit filters if provided
    if (args.filters && args.filters.length > 0) {
      searchRequest.filterGroups = [{ filters: args.filters }];
    }

    // Handle text query by searching appropriate fields for the object type
    if (args.query && args.query.trim()) {
      const searchFields = SEARCHABLE_TEXT_FIELDS[objectType] || [];
      if (searchFields.length > 0) {
        // Create OR filter group - search any of the text fields
        // HubSpot search uses filter groups with AND within group, OR between groups
        const queryFilters = searchFields.map(field => ({
          filters: [{ propertyName: field, operator: 'CONTAINS_TOKEN', value: args.query! }]
        }));

        // If we have existing filters, combine with AND logic
        if (searchRequest.filterGroups && searchRequest.filterGroups.length > 0) {
          // Existing filters get combined with each query filter group
          const existingFilters = searchRequest.filterGroups[0].filters;
          searchRequest.filterGroups = queryFilters.map(qf => ({
            filters: [...existingFilters, ...qf.filters]
          }));
        } else {
          searchRequest.filterGroups = queryFilters;
        }
      } else {
        logger.warn(`No searchable text fields defined for ${objectType}, ignoring query parameter`);
      }
    }

    // Validate requested read-property names against the live schema in
    // parallel with the search. Unknown names are surfaced as a structured,
    // model-visible warning (silent-failure-is-a-bug) without failing the read.
    const [result, validation] = await Promise.all([
      client.searchObjects(objectType, searchRequest),
      validateRequestedProperties(objectType, args.properties),
    ]);
    logger.info(`Found ${result.results.length} ${objectType}`);
    return attachPropertyValidation(sanitizeHubSpotResponse(result, `hubspot:crm/${objectType}`), validation);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType, operation: 'search', args });
    logger.error(`Search ${objectType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Generic get handler
async function getObject(objectType: string, objectId: string, args: GetArgs) {
  // Note: associations is forwarded as ?associations=… so callers can resolve
  // related records (e.g. line_item -> deals) in a single request.
  try {
    const client = await getHubSpotClientAsync();
    // Validate requested read-property names against the live schema in
    // parallel with the get. Unknown names ride along as a structured,
    // model-visible warning without failing the read.
    const [result, validation] = await Promise.all([
      client.getObject(objectType, objectId, args.properties, args.associations),
      validateRequestedProperties(objectType, args.properties),
    ]);
    return attachPropertyValidation(sanitizeHubSpotResponse(result, `hubspot:crm/${objectType}`), validation);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType, operation: 'get', args: { objectId, ...args } });
    logger.error(`Get ${objectType} ${objectId} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Generic create handler
async function createObject(objectType: string, args: CreateArgs) {
  assertRecordStringBodySizes(args.properties);

  try {
    const client = await getHubSpotClientAsync();
    const enrichedProperties = await injectHostMetadata(args.properties, objectType);
    const result = await client.createObject(objectType, enrichedProperties);
    logger.info(`Created ${objectType} with ID: ${result.id}`);
    return sanitizeHubSpotResponse(result, `hubspot:crm/${objectType}`);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType, operation: 'create', args });
    logger.error(`Create ${objectType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Generic update handler
async function updateObject(objectType: string, objectId: string, args: UpdateArgs) {
  assertRecordStringBodySizes(args.properties);

  try {
    const client = await getHubSpotClientAsync();
    const result = await client.updateObject(objectType, objectId, args.properties);
    logger.info(`Updated ${objectType} ${objectId}`);
    return sanitizeHubSpotResponse(result, `hubspot:crm/${objectType}`);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType, operation: 'update', args: { objectId, ...args } });
    logger.error(`Update ${objectType} ${objectId} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Generic delete handler
async function deleteObject(objectType: string, objectId: string) {
  try {
    const client = await getHubSpotClientAsync();
    await client.deleteObject(objectType, objectId);
    logger.info(`Deleted ${objectType} ${objectId}`);
    return { success: true, message: `${objectType} ${objectId} deleted` };
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType, operation: 'delete', args: { objectId } });
    logger.error(`Delete ${objectType} ${objectId} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Contact handlers
export async function handleSearchContacts(args: SearchArgs) {
  return searchObjects('contacts', args);
}

export async function handleGetContact(args: { contactId: string } & GetArgs) {
  return getObject('contacts', args.contactId, args);
}

export async function handleCreateContact(args: CreateArgs) {
  return createObject('contacts', args);
}

export async function handleUpdateContact(args: { contactId: string } & UpdateArgs) {
  return updateObject('contacts', args.contactId, args);
}

export async function handleDeleteContact(args: { contactId: string }) {
  return deleteObject('contacts', args.contactId);
}

// Company handlers
export async function handleSearchCompanies(args: SearchArgs) {
  return searchObjects('companies', args);
}

export async function handleGetCompany(args: { companyId: string } & GetArgs) {
  return getObject('companies', args.companyId, args);
}

export async function handleCreateCompany(args: CreateArgs) {
  return createObject('companies', args);
}

export async function handleUpdateCompany(args: { companyId: string } & UpdateArgs) {
  return updateObject('companies', args.companyId, args);
}

export async function handleDeleteCompany(args: { companyId: string }) {
  return deleteObject('companies', args.companyId);
}

// Deal handlers
export async function handleSearchDeals(args: SearchArgs) {
  return searchObjects('deals', args);
}

export async function handleGetDeal(args: { dealId: string } & GetArgs) {
  return getObject('deals', args.dealId, args);
}

export async function handleCreateDeal(args: CreateArgs & { hubspot_owner_id?: string }) {
  const properties = args.hubspot_owner_id
    ? { ...args.properties, hubspot_owner_id: args.hubspot_owner_id }
    : args.properties;
  return createObject('deals', { properties });
}

export async function handleUpdateDeal(args: { dealId: string } & UpdateArgs) {
  return updateObject('deals', args.dealId, args);
}

export async function handleDeleteDeal(args: { dealId: string }) {
  return deleteObject('deals', args.dealId);
}

// Ticket handlers
export async function handleSearchTickets(args: SearchArgs) {
  return searchObjects('tickets', args);
}

export async function handleGetTicket(args: { ticketId: string } & GetArgs) {
  return getObject('tickets', args.ticketId, args);
}

export async function handleCreateTicket(args: CreateArgs) {
  return createObject('tickets', args);
}

export async function handleUpdateTicket(args: { ticketId: string } & UpdateArgs) {
  return updateObject('tickets', args.ticketId, args);
}

export async function handleDeleteTicket(args: { ticketId: string }) {
  return deleteObject('tickets', args.ticketId);
}

// Lead handlers
export async function handleSearchLeads(args: SearchArgs) {
  return searchObjects('leads', args);
}

export async function handleGetLead(args: { leadId: string } & GetArgs) {
  return getObject('leads', args.leadId, args);
}

export async function handleCreateLead(args: { properties: Record<string, string>; contactId: string }) {
  assertRecordStringBodySizes(args.properties);

  try {
    const client = await getHubSpotClientAsync();
    const enrichedProperties = await injectHostMetadata(args.properties, 'leads');
    const associations = [{
      to: { id: args.contactId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 578 }] // lead_to_primary_contact
    }];
    const result = await client.createObjectWithAssociations('leads', enrichedProperties, associations);
    logger.info(`Created lead ${result.id} associated with contact ${args.contactId}`);
    return sanitizeHubSpotResponse(result, 'hubspot:crm/leads');
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: 'leads', operation: 'create', args });
    logger.error(`Create lead failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleUpdateLead(args: { leadId: string } & UpdateArgs) {
  return updateObject('leads', args.leadId, args);
}

export async function handleDeleteLead(args: { leadId: string }) {
  return deleteObject('leads', args.leadId);
}

// Task handlers
export async function handleSearchTasks(args: SearchArgs) {
  return searchObjects('tasks', args);
}

export async function handleGetTask(args: { taskId: string } & GetArgs) {
  return getObject('tasks', args.taskId, args);
}

export async function handleCreateTask(args: CreateArgs) {
  return createObject('tasks', args);
}

export async function handleUpdateTask(args: { taskId: string } & UpdateArgs) {
  return updateObject('tasks', args.taskId, args);
}

export async function handleDeleteTask(args: { taskId: string }) {
  return deleteObject('tasks', args.taskId);
}

// Note handlers
export async function handleSearchNotes(args: SearchArgs) {
  return searchObjects('notes', args);
}

export async function handleGetNote(args: { noteId: string } & GetArgs) {
  return getObject('notes', args.noteId, args);
}

export async function handleUpdateNote(args: { noteId: string } & UpdateArgs) {
  return updateObject('notes', args.noteId, args);
}

export async function handleDeleteNote(args: { noteId: string }) {
  return deleteObject('notes', args.noteId);
}

export async function handleCreateNote(args: NoteCreateArgs) {
  assertRecordStringBodySizes(args.properties);
  assertAssociationFanOut(args.associations);

  try {
    const client = await getHubSpotClientAsync();
    const enrichedProperties = await injectHostMetadata(args.properties, 'notes');
    const note = await client.createObject('notes', enrichedProperties);
    
    // Create associations if provided
    if (args.associations) {
      const associationPromises: Promise<void>[] = [];
      
      if (args.associations.contactIds) {
        for (const contactId of args.associations.contactIds) {
          associationPromises.push(
            client.createAssociation('notes', note.id, 'contacts', contactId, 'note_to_contact')
          );
        }
      }
      
      if (args.associations.companyIds) {
        for (const companyId of args.associations.companyIds) {
          associationPromises.push(
            client.createAssociation('notes', note.id, 'companies', companyId, 'note_to_company')
          );
        }
      }
      
      if (args.associations.dealIds) {
        for (const dealId of args.associations.dealIds) {
          associationPromises.push(
            client.createAssociation('notes', note.id, 'deals', dealId, 'note_to_deal')
          );
        }
      }
      
      if (args.associations.ticketIds) {
        for (const ticketId of args.associations.ticketIds) {
          associationPromises.push(
            client.createAssociation('notes', note.id, 'tickets', ticketId, 'note_to_ticket')
          );
        }
      }
      
      await Promise.all(associationPromises);
      logger.info(`Created note ${note.id} with associations`);
    }
    
    return sanitizeHubSpotResponse(note, 'hubspot:crm/notes');
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: 'notes', operation: 'create', args });
    logger.error(`Create note failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Association handlers
export async function handleCreateAssociation(args: {
  fromObjectType: string;
  fromObjectId: string;
  toObjectType: string;
  toObjectId: string;
  associationType: string;
}) {
  try {
    const client = await getHubSpotClientAsync();
    await client.createAssociation(
      args.fromObjectType,
      args.fromObjectId,
      args.toObjectType,
      args.toObjectId,
      args.associationType
    );
    logger.info(`Created association: ${args.fromObjectType}/${args.fromObjectId} -> ${args.toObjectType}/${args.toObjectId}`);
    return { success: true, message: 'Association created' };
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: 'associations', operation: 'create', args });
    logger.error(`Create association failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetAssociations(args: {
  fromObjectType: string;
  fromObjectId: string;
  toObjectType: string;
}) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getAssociations(args.fromObjectType, args.fromObjectId, args.toObjectType);
    return sanitizeHubSpotResponse(result, 'hubspot:associations');
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: 'associations', operation: 'get', args });
    logger.error(`Get associations failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleDeleteAssociation(args: {
  fromObjectType: string;
  fromObjectId: string;
  toObjectType: string;
  toObjectId: string;
  associationType: string;
}) {
  try {
    const client = await getHubSpotClientAsync();
    await client.deleteAssociation(
      args.fromObjectType,
      args.fromObjectId,
      args.toObjectType,
      args.toObjectId,
      args.associationType
    );
    logger.info(`Deleted association: ${args.fromObjectType}/${args.fromObjectId} -> ${args.toObjectType}/${args.toObjectId}`);
    return { success: true, message: 'Association deleted' };
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: 'associations', operation: 'delete', args });
    logger.error(`Delete association failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Property handlers
export async function handleListProperties(args: { objectType: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.listProperties(args.objectType);
    return sanitizeHubSpotResponse(result, 'hubspot:properties', PROPERTY_SCHEMA_LITERAL_KEYS);
  } catch (error) {
    const parsed = parseSharedHubSpotError(error, { objectType: args.objectType, operation: 'list_properties', args });
    logger.error(`List properties for ${args.objectType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Owner handlers
export async function handleListOwners(args: { limit?: number }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.listOwners(args.limit || 100);
    return sanitizeHubSpotResponse(result, 'hubspot:owners');
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: 'owners', operation: 'list', args });
    logger.error(`List owners failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetOwner(args: { ownerId: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getOwner(args.ownerId);
    return sanitizeHubSpotResponse(result, 'hubspot:owners');
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: 'owners', operation: 'get', args });
    logger.error(`Get owner ${args.ownerId} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Pipeline handlers
export async function handleListPipelines(args: { objectType: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.listPipelines(args.objectType);
    return sanitizeHubSpotResponse(result, 'hubspot:pipelines');
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: args.objectType, operation: 'list_pipelines', args });
    logger.error(`List pipelines for ${args.objectType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetPipeline(args: { objectType: string; pipelineId: string }) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getPipeline(args.objectType, args.pipelineId);
    return sanitizeHubSpotResponse(result, 'hubspot:pipelines');
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: args.objectType, operation: 'get_pipeline', args });
    logger.error(`Get pipeline ${args.pipelineId} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Engagement handlers
interface EngagementSearchArgs {
  filters?: Array<{ propertyName: string; operator: string; value: string }>;
  properties?: string[];
  limit?: number;
  after?: string;
}

interface EngagementCreateArgs {
  properties: Record<string, string>;
  associations?: {
    contactIds?: string[];
    companyIds?: string[];
    dealIds?: string[];
  };
}

// Association type IDs for engagements (from HubSpot's association schema)
const ENGAGEMENT_ASSOCIATION_TYPES = {
  call_to_contact: 194,
  call_to_company: 182,
  call_to_deal: 206,
  email_to_contact: 198,
  email_to_company: 186,
  email_to_deal: 210,
  meeting_to_contact: 200,
  meeting_to_company: 188,
  meeting_to_deal: 212
};

async function searchEngagement(engagementType: string, args: EngagementSearchArgs) {
  const searchRequest: {
    limit: number;
    properties?: string[];
    after?: string;
    filterGroups?: Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }>;
  } = {
    limit: args.limit || 10,
    properties: args.properties,
    after: args.after
  };
  
  if (args.filters && args.filters.length > 0) {
    searchRequest.filterGroups = [{ filters: args.filters }];
  }
  
  try {
    // Structural requirement: keep getHubSpotClientAsync() inside this try/catch
    // so refresh failures map through parseHubSpotError() to auth_required.
    const client = await getHubSpotClientAsync();
    const result = await client.searchEngagements(engagementType, searchRequest);
    return sanitizeHubSpotResponse(result, `hubspot:engagements/${engagementType}`);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: engagementType, operation: 'search', args });
    logger.error(`Search ${engagementType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

async function getEngagement(engagementType: string, engagementId: string, properties?: string[]) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getEngagement(engagementType, engagementId, properties);
    return sanitizeHubSpotResponse(result, `hubspot:engagements/${engagementType}`);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: engagementType, operation: 'get', args: { engagementId } });
    logger.error(`Get ${engagementType} ${engagementId} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

async function createEngagement(engagementType: string, args: EngagementCreateArgs) {
  assertRecordStringBodySizes(args.properties);
  assertAssociationFanOut(args.associations);

  try {
    const client = await getHubSpotClientAsync();
    const enrichedProperties = await injectHostMetadata(args.properties, engagementType);
    
    // Build associations array if provided
    let associations: Array<{ to: { id: string }; types: Array<{ associationCategory: string; associationTypeId: number }> }> | undefined;
    
    if (args.associations) {
      associations = [];
      const typePrefix = engagementType.slice(0, -1); // 'calls' -> 'call', 'emails' -> 'email', etc.
      
      if (args.associations.contactIds) {
        for (const contactId of args.associations.contactIds) {
          const typeKey = `${typePrefix}_to_contact` as keyof typeof ENGAGEMENT_ASSOCIATION_TYPES;
          associations.push({
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ENGAGEMENT_ASSOCIATION_TYPES[typeKey] }]
          });
        }
      }
      
      if (args.associations.companyIds) {
        for (const companyId of args.associations.companyIds) {
          const typeKey = `${typePrefix}_to_company` as keyof typeof ENGAGEMENT_ASSOCIATION_TYPES;
          associations.push({
            to: { id: companyId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ENGAGEMENT_ASSOCIATION_TYPES[typeKey] }]
          });
        }
      }
      
      if (args.associations.dealIds) {
        for (const dealId of args.associations.dealIds) {
          const typeKey = `${typePrefix}_to_deal` as keyof typeof ENGAGEMENT_ASSOCIATION_TYPES;
          associations.push({
            to: { id: dealId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ENGAGEMENT_ASSOCIATION_TYPES[typeKey] }]
          });
        }
      }
    }
    
    const result = await client.createEngagement(engagementType, enrichedProperties, associations);
    logger.info(`Created ${engagementType} with ID: ${result.id}`);
    return sanitizeHubSpotResponse(result, `hubspot:engagements/${engagementType}`);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: engagementType, operation: 'create', args });
    logger.error(`Create ${engagementType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Call handlers
export async function handleSearchCalls(args: EngagementSearchArgs) {
  return searchEngagement('calls', args);
}

export async function handleGetCall(args: { callId: string; properties?: string[] }) {
  return getEngagement('calls', args.callId, args.properties);
}

export async function handleCreateCall(args: EngagementCreateArgs) {
  return createEngagement('calls', args);
}

// Email handlers
export async function handleSearchEmails(args: EngagementSearchArgs) {
  return searchEngagement('emails', args);
}

export async function handleGetEmail(args: { emailId: string; properties?: string[] }) {
  return getEngagement('emails', args.emailId, args.properties);
}

export async function handleCreateEmail(args: EngagementCreateArgs) {
  return createEngagement('emails', args);
}

// Meeting handlers
export async function handleSearchMeetings(args: EngagementSearchArgs) {
  return searchEngagement('meetings', args);
}

export async function handleGetMeeting(args: { meetingId: string; properties?: string[] }) {
  return getEngagement('meetings', args.meetingId, args.properties);
}

export async function handleCreateMeeting(args: EngagementCreateArgs) {
  return createEngagement('meetings', args);
}

// Contact engagements (timeline) handler
export async function handleGetContactEngagements(args: { contactId: string; limit?: number }) {
  try {
    const client = await getHubSpotClientAsync();
    const limit = args.limit || 5;
    
    // Get associations for the contact to find related engagements
    const [callAssocs, emailAssocs, meetingAssocs] = await Promise.all([
      client.getAssociations('contacts', args.contactId, 'calls').catch(() => ({ results: [] })),
      client.getAssociations('contacts', args.contactId, 'emails').catch(() => ({ results: [] })),
      client.getAssociations('contacts', args.contactId, 'meetings').catch(() => ({ results: [] }))
    ]);
    
    // Fetch details for each engagement type (limited)
    const callIds = callAssocs.results.slice(0, limit).map(a => a.id);
    const emailIds = emailAssocs.results.slice(0, limit).map(a => a.id);
    const meetingIds = meetingAssocs.results.slice(0, limit).map(a => a.id);
    
    const defaultProps = ['hs_timestamp', 'hubspot_owner_id'];
    const callProps = [...defaultProps, 'hs_call_title', 'hs_call_body', 'hs_call_direction', 'hs_call_status', 'hs_call_duration'];
    const emailProps = [...defaultProps, 'hs_email_subject', 'hs_email_text', 'hs_email_direction', 'hs_email_status'];
    const meetingProps = [...defaultProps, 'hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome'];
    
    const [calls, emails, meetings] = await Promise.all([
      Promise.all(callIds.map(id => client.getEngagement('calls', id, callProps).catch(() => null))),
      Promise.all(emailIds.map(id => client.getEngagement('emails', id, emailProps).catch(() => null))),
      Promise.all(meetingIds.map(id => client.getEngagement('meetings', id, meetingProps).catch(() => null)))
    ]);
    
    return {
      contactId: args.contactId,
      calls: calls.filter(Boolean),
      emails: emails.filter(Boolean),
      meetings: meetings.filter(Boolean),
      summary: {
        totalCalls: callAssocs.results.length,
        totalEmails: emailAssocs.results.length,
        totalMeetings: meetingAssocs.results.length
      }
    };
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: 'contact_engagements', operation: 'get', args });
    logger.error(`Get contact engagements failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Product handlers
export async function handleSearchProducts(args: SearchArgs) {
  return searchObjects('products', args);
}

export async function handleGetProduct(args: { productId: string; properties?: string[] }) {
  return getObject('products', args.productId, args);
}

export async function handleCreateProduct(args: CreateArgs) {
  return createObject('products', args);
}

export async function handleUpdateProduct(args: { productId: string; properties: Record<string, string> }) {
  return updateObject('products', args.productId, args);
}

// Line Item handlers
export async function handleSearchLineItems(args: SearchArgs) {
  return searchObjects('line_items', args);
}

export async function handleGetLineItem(args: { lineItemId: string; properties?: string[]; associations?: string[] }) {
  return getObject('line_items', args.lineItemId, args);
}

export async function handleCreateLineItem(args: { properties: Record<string, string>; dealId?: string }) {
  assertRecordStringBodySizes(args.properties);

  try {
    const client = await getHubSpotClientAsync();
    const enrichedProperties = await injectHostMetadata(args.properties, 'line_items');
    
    // Build associations array if dealId provided
    const associations = args.dealId ? [{
      to: { id: args.dealId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }] // line_item_to_deal
    }] : undefined;
    
    const result = await client.createObjectWithAssociations('line_items', enrichedProperties, associations);
    
    logger.info(`Created line item ${result.id}${args.dealId ? ` associated with deal ${args.dealId}` : ''}`);
    return sanitizeHubSpotResponse(result, 'hubspot:crm/line_items');
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: 'line_items', operation: 'create', args });
    logger.error(`Create line item failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

// Custom object handlers — generic CRM object type (e.g. a tenant-defined
// 'p_widgets' or '2-1234567'). Unlike the per-object search handlers, the
// text query rides HubSpot's native full-text `query` search field because a
// custom object's searchable properties aren't known to the connector.
interface CustomObjectSearchArgs {
  objectType: string;
  query?: string;
  filters?: SearchFilter[];
  properties?: string[];
  limit?: number;
  after?: string;
}

export async function handleSearchCustomObjects(args: CustomObjectSearchArgs) {
  assertHubSpotObjectType(args.objectType, 'objectType');

  try {
    const client = await getHubSpotClientAsync();
    const searchRequest: SearchRequest = {
      limit: args.limit || 10,
      properties: args.properties,
      after: args.after
    };
    if (args.query && args.query.trim()) {
      searchRequest.query = args.query;
    }
    if (args.filters && args.filters.length > 0) {
      searchRequest.filterGroups = [{ filters: args.filters }];
    }

    const [result, validation] = await Promise.all([
      client.searchObjects(args.objectType, searchRequest),
      validateRequestedProperties(args.objectType, args.properties),
    ]);
    logger.info(`Found ${result.results.length} ${args.objectType}`);
    return attachPropertyValidation(sanitizeHubSpotResponse(result, `hubspot:crm/${args.objectType}`), validation);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: args.objectType, operation: 'search', args });
    logger.error(`Search ${args.objectType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleGetCustomObject(args: { objectType: string; objectId: string } & GetArgs) {
  assertHubSpotObjectType(args.objectType, 'objectType');
  return getObject(args.objectType, args.objectId, args);
}

export async function handleCreateCustomObject(args: { objectType: string } & CreateArgs) {
  assertHubSpotObjectType(args.objectType, 'objectType');
  return createObject(args.objectType, args);
}
