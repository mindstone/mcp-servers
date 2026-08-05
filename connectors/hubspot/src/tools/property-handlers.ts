import { getHubSpotClientAsync, PropertyOption } from '../api/hubspot-client.js';
import { parseHubSpotError } from '../utils/error-parser.js';
import { PROPERTY_SCHEMA_LITERAL_KEYS, sanitizeHubSpotResponse } from '../sanitize.js';
import logger from '../utils/logger.js';

interface GetPropertyArgs {
  objectType: string;
  propertyName: string;
}

interface CreatePropertyArgs {
  objectType: string;
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
  description?: string;
  options?: PropertyOption[];
}

interface UpdatePropertyArgs {
  objectType: string;
  propertyName: string;
  label?: string;
  description?: string;
  options?: PropertyOption[];
}

interface DeletePropertyArgs {
  objectType: string;
  propertyName: string;
}

interface ListPropertyGroupsArgs {
  objectType: string;
}

interface CreatePropertyGroupArgs {
  objectType: string;
  name: string;
  label: string;
  displayOrder?: number;
}

export async function handleGetProperty(args: GetPropertyArgs) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.getProperty(args.objectType, args.propertyName);
    return sanitizeHubSpotResponse(result, 'hubspot:properties', PROPERTY_SCHEMA_LITERAL_KEYS);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: args.objectType, operation: 'get_property', args });
    logger.error(`Get property ${args.propertyName} on ${args.objectType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleCreateProperty(args: CreatePropertyArgs) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.createProperty(args.objectType, {
      name: args.name,
      label: args.label,
      type: args.type,
      fieldType: args.fieldType,
      groupName: args.groupName,
      description: args.description,
      options: args.options,
    });

    logger.info(`Created property ${result.name} on ${args.objectType}`);
    return sanitizeHubSpotResponse(result, 'hubspot:properties', PROPERTY_SCHEMA_LITERAL_KEYS);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: args.objectType, operation: 'create_property', args });
    logger.error(`Create property on ${args.objectType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleUpdateProperty(args: UpdatePropertyArgs) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.updateProperty(args.objectType, args.propertyName, {
      label: args.label,
      description: args.description,
      options: args.options,
    });

    logger.info(`Updated property ${args.propertyName} on ${args.objectType}`);
    return sanitizeHubSpotResponse(result, 'hubspot:properties', PROPERTY_SCHEMA_LITERAL_KEYS);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: args.objectType, operation: 'update_property', args });
    logger.error(`Update property ${args.propertyName} on ${args.objectType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleDeleteProperty(args: DeletePropertyArgs) {
  try {
    const client = await getHubSpotClientAsync();
    await client.deleteProperty(args.objectType, args.propertyName);
    logger.info(`Archived property ${args.propertyName} on ${args.objectType}`);

    return {
      success: true,
      message: `Property ${args.propertyName} archived on ${args.objectType}`,
    };
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: args.objectType, operation: 'delete_property', args });
    logger.error(`Delete property ${args.propertyName} on ${args.objectType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleListPropertyGroups(args: ListPropertyGroupsArgs) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.listPropertyGroups(args.objectType);
    return sanitizeHubSpotResponse(result, 'hubspot:properties', PROPERTY_SCHEMA_LITERAL_KEYS);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: args.objectType, operation: 'list_property_groups', args });
    logger.error(`List property groups for ${args.objectType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}

export async function handleCreatePropertyGroup(args: CreatePropertyGroupArgs) {
  try {
    const client = await getHubSpotClientAsync();
    const result = await client.createPropertyGroup(args.objectType, {
      name: args.name,
      label: args.label,
      displayOrder: args.displayOrder,
    });

    logger.info(`Created property group ${args.name} on ${args.objectType}`);
    return sanitizeHubSpotResponse(result, 'hubspot:properties', PROPERTY_SCHEMA_LITERAL_KEYS);
  } catch (error) {
    const parsed = parseHubSpotError(error, { objectType: args.objectType, operation: 'create_property_group', args });
    logger.error(`Create property group on ${args.objectType} failed:`, parsed);
    throw new Error(JSON.stringify(parsed));
  }
}
