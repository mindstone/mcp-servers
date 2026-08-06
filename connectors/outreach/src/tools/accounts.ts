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
import type { JsonApiResource } from '../types.js';

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    'outreach_list_accounts',
    {
      description: `List Outreach accounts (companies). Example: { "name": "Acme" } or { "domain": "acme.com" }

Returns company accounts with domain, industry, and owner info.`,
      inputSchema: z.object({
        name: z.string().optional().describe('Filter by account name (partial match)'),
        domain: z.string().optional().describe('Filter by domain'),
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
      if (args.name) params['filter[name]'] = args.name;
      if (args.domain) params['filter[domain]'] = args.domain;

      const response = await outreachFetch('/accounts', { params });
      const records = formatResources(response.data);
      return JSON.stringify({
        ok: true,
        records,
        // The API may omit meta.count; fall back to the number of records
        // actually returned rather than reporting a misleading 0.
        count: response.meta?.count ?? records.length,
        page: response.meta?.page,
      });
    }),
  );

  server.registerTool(
    'outreach_get_account',
    {
      description: `Get full details of an Outreach account (company) by ID. Example: { "id": "789" }

Returns account fields, custom fields, and associated prospects count.`,
      inputSchema: z.object({
        id: z.string().min(1).describe('Account ID'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    withErrorHandling(async (args) => {
      const response = await outreachFetch(`/accounts/${args.id}`);
      return JSON.stringify({
        ok: true,
        ...formatResource(response.data as JsonApiResource),
      });
    }),
  );
}
