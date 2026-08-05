import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import {
  outreachFetch,
  formatResource,
  formatResources,
  clampLimit,
  paginationParams,
} from '../client.js';
import { ConnectorError, type JsonApiResource } from '../types.js';

const CUSTOM_FIELD_KEY = /^custom([1-9]|[12][0-9]|3[0-5])$/;

const customFieldsSchema = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .optional()
  .describe('Outreach custom field values, keyed custom1 through custom35 (e.g. { "custom1": "enterprise" })');

/**
 * Merge validated custom1..custom35 fields into a prospect attributes payload.
 * Key format is validated here (not just by Zod) so the error can name the
 * offending key and the accepted range.
 */
function applyCustomFields(
  attributes: Record<string, unknown>,
  customFields: Record<string, string | number | boolean | null> | undefined,
): void {
  if (!customFields) return;
  for (const [key, value] of Object.entries(customFields)) {
    if (!CUSTOM_FIELD_KEY.test(key)) {
      throw new ConnectorError(
        `Invalid custom field key: ${key}`,
        'VALIDATION_ERROR',
        'Outreach prospect custom fields are named custom1 through custom35.',
      );
    }
    attributes[key] = value;
  }
}

export function registerProspectTools(server: McpServer): void {
  server.registerTool(
    'outreach_search_prospects',
    {
      description: `Search Outreach prospects. Example: { "email": "jane@acme.com" } or { "name": "Jane", "limit": 10 }

WORKFLOW: Search first, then use outreach_get_prospect for full details.
FILTERS: name, email, company, tags. All optional — omit all for recent prospects.
PAGINATION: Default 25, max 50. Use page_offset for next page.`,
      inputSchema: z.object({
        name: z.string().optional().describe('Filter by first or last name (partial match)'),
        email: z.string().optional().describe('Filter by email address (exact match)'),
        company: z.string().optional().describe('Filter by company name'),
        tags: z.array(z.string()).optional().describe('Filter by tags'),
        limit: z.number().min(1).max(50).default(25).optional().describe('Max results (default 25, max 50)'),
        page_offset: z.number().min(0).optional().describe('Record offset into the result list for pagination (maps to the API\'s page[offset]; e.g. 25 for the second page with limit 25)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const limit = clampLimit(args.limit);
      const params: Record<string, string> = { ...paginationParams(limit, args.page_offset) };
      if (args.email) params['filter[emails]'] = args.email;
      if (args.name) params['filter[firstName]'] = args.name;
      if (args.company) params['filter[company]'] = args.company;
      if (args.tags?.length) params['filter[tags]'] = args.tags.join(',');

      const response = await outreachFetch('/prospects', { params });
      const records = formatResources(response.data);
      return JSON.stringify({
        ok: true,
        records,
        count: response.meta?.count ?? records.length,
        page: response.meta?.page,
      });
    }),
  );

  server.registerTool(
    'outreach_get_prospect',
    {
      description: `Get full details of an Outreach prospect by ID. Example: { "id": "123" }

Returns all prospect fields including custom fields, tags, engagement data.
RELATED TOOLS: outreach_search_prospects to find IDs first.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Prospect ID'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const response = await outreachFetch(`/prospects/${args.id}`);
      const record = formatResource(response.data as JsonApiResource);
      return JSON.stringify({ ok: true, ...record });
    }),
  );

  server.registerTool(
    'outreach_create_prospect',
    {
      description: `Create a new prospect in Outreach. Example: { "email": "jane@acme.com", "first_name": "Jane", "last_name": "Doe" }

REQUIRED: At least email or last_name.
COMMON MISTAKES: Don't forget to associate with an account via account_id if known.`,
      inputSchema: z.object({
        email: z.string().optional().describe('Email address'),
        first_name: z.string().optional().describe('First name'),
        last_name: z.string().optional().describe('Last name'),
        title: z.string().optional().describe('Job title'),
        company: z.string().optional().describe('Company name'),
        account_id: z.string().optional().describe('Associated Outreach account ID'),
        tags: z.array(z.string()).optional().describe('Tags to apply'),
        custom_fields: customFieldsSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      if (!args.email && !args.last_name) {
        throw new ConnectorError(
          'At least email or last_name is required',
          'VALIDATION_ERROR',
          'Provide email or last_name.',
        );
      }

      const attributes: Record<string, unknown> = {};
      if (args.email) attributes.emails = [args.email];
      if (args.first_name) attributes.firstName = args.first_name;
      if (args.last_name) attributes.lastName = args.last_name;
      if (args.title) attributes.title = args.title;
      if (args.company) attributes.company = args.company;
      if (args.tags) attributes.tags = args.tags;
      applyCustomFields(attributes, args.custom_fields);

      const body: Record<string, unknown> = {
        data: {
          type: 'prospect',
          attributes,
          ...(args.account_id
            ? {
                relationships: {
                  account: { data: { type: 'account', id: args.account_id } },
                },
              }
            : {}),
        },
      };

      const response = await outreachFetch('/prospects', { method: 'POST', body });
      return JSON.stringify({
        ok: true,
        status: 'created',
        ...formatResource(response.data as JsonApiResource),
      });
    }),
  );

  server.registerTool(
    'outreach_update_prospect',
    {
      description: `Update an existing prospect. Example: { "id": "123", "title": "VP Sales" }

Only provided fields are updated. Use outreach_search_prospects to find the ID.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Prospect ID (required)'),
        email: z.string().optional().describe('Email address'),
        first_name: z.string().optional().describe('First name'),
        last_name: z.string().optional().describe('Last name'),
        title: z.string().optional().describe('Job title'),
        company: z.string().optional().describe('Company name'),
        tags: z.array(z.string()).optional().describe('Tags to apply'),
        custom_fields: customFieldsSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const attributes: Record<string, unknown> = {};
      if (args.email) attributes.emails = [args.email];
      if (args.first_name) attributes.firstName = args.first_name;
      if (args.last_name) attributes.lastName = args.last_name;
      if (args.title) attributes.title = args.title;
      if (args.company) attributes.company = args.company;
      if (args.tags) attributes.tags = args.tags;
      applyCustomFields(attributes, args.custom_fields);

      const body = { data: { type: 'prospect', id: args.id, attributes } };
      const response = await outreachFetch(`/prospects/${args.id}`, { method: 'PATCH', body });
      return JSON.stringify({
        ok: true,
        status: 'updated',
        ...formatResource(response.data as JsonApiResource),
      });
    }),
  );
}
