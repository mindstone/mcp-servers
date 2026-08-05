import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { servicenowFetch, buildQueryParams } from '../client.js';
import { sanitizeRecord, sanitizeRecords } from '../sanitize.js';
import { withErrorHandling } from '../utils.js';

const CATALOG_SOURCE = 'servicenow:catalog-item';

export function registerCatalogTools(server: McpServer): void {
  // ── list_servicenow_catalog_items ─────────────────────────────

  server.registerTool(
    'list_servicenow_catalog_items',
    {
      description:
        'List or search service catalog items in ServiceNow (the sc_cat_item table). ' +
        'Returns: sys_id, name, short_description, category, price, active. ' +
        'Simple text queries are automatically converted to LIKE queries on the item name. ' +
        'For advanced filtering, use ServiceNow encoded query syntax directly. ' +
        'Use get_servicenow_catalog_item for full details of a specific item.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Search keywords or ServiceNow encoded query (e.g., "active=true^categoryLIKEhardware")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .default(20)
          .describe('Max results to return (default: 20, max: 1000)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe('Offset for pagination (default: 0)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      let query = args.query;

      // If the query doesn't look like an encoded query, treat it as a keyword search
      if (query && !query.includes('=') && !query.includes('^')) {
        query = `nameLIKE${query}^ORshort_descriptionLIKE${query}`;
      }

      const params = buildQueryParams({
        sysparm_limit: args.limit ?? 20,
        sysparm_offset: args.offset ?? 0,
        sysparm_display_value: 'true',
        sysparm_fields: 'sys_id,name,short_description,category,price,active',
        sysparm_query: query,
      });
      const items = await servicenowFetch<Array<Record<string, unknown>>>(
        `/sc_cat_item${params}`,
      );
      return JSON.stringify({
        ok: true,
        catalog_items: sanitizeRecords(items, CATALOG_SOURCE),
        count: items.length,
      });
    }),
  );

  // ── get_servicenow_catalog_item ───────────────────────────────

  server.registerTool(
    'get_servicenow_catalog_item',
    {
      description:
        'Get a single service catalog item by sys_id. ' +
        'Returns the full catalog item record with all fields, including the description. ' +
        'Use list_servicenow_catalog_items to find the sys_id first.',
      inputSchema: z.object({
        sys_id: z
          .string()
          .min(1)
          .describe('Catalog item sys_id (use list_servicenow_catalog_items to find it)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const item = await servicenowFetch<Record<string, unknown>>(
        `/sc_cat_item/${encodeURIComponent(args.sys_id)}?sysparm_display_value=true`,
      );
      return JSON.stringify({
        ok: true,
        catalog_item: sanitizeRecord(item, CATALOG_SOURCE),
      });
    }),
  );
}
