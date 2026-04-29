/**
 * QuickBooks query and entity retrieval tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils.js';
import { qboFetch, qboQuery } from '../client.js';

export function registerQueryTools(server: McpServer): void {
  server.registerTool(
    'query_quickbooks',
    {
      description: `Run a QuickBooks query using the QuickBooks Query Language.

Returns matching entities. QuickBooks uses a SQL-like query language.

Example: { "query": "SELECT * FROM Invoice WHERE Balance > '0' ORDERBY DueDate" }
Example: { "query": "SELECT * FROM Customer WHERE Active = true" }

WORKFLOW:
1. Use this for flexible searches across any entity type
2. Entity names are PascalCase: Invoice, Customer, Vendor, Bill, Employee, etc.
3. String values use single quotes, dates use 'YYYY-MM-DD' format

COMMON MISTAKES:
- Entity names are case-sensitive PascalCase (Invoice, not invoice)
- Use single quotes for string/date values, not double quotes
- LIKE operator uses % wildcard: DisplayName LIKE '%Smith%'`,
      inputSchema: z.object({
        query: z.string().describe('QuickBooks Query Language statement'),
        limit: z.number().optional().describe('Max results (default: 100, max: 1000)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const query = args.query;
      const limit = Math.min(args.limit ?? 100, 1000);

      // Extract entity name from query for response parsing
      const entityMatch = query.match(/FROM\s+(\w+)/i);
      const entityName = entityMatch ? entityMatch[1] : 'Unknown';
      const results = await qboQuery(entityName, query, limit);
      return JSON.stringify({ ok: true, entity: entityName, data: results, count: results.length });
    }),
  );

  server.registerTool(
    'get_quickbooks_entity',
    {
      description: `Get a single QuickBooks entity by type and ID.

Example: { "entityType": "Invoice", "entityId": "123" }

Supported entity types: Account, Bill, BillPayment, Customer, Employee, Estimate, Invoice, Item, JournalEntry, Purchase, Vendor`,
      inputSchema: z.object({
        entityType: z.enum([
          'Account', 'Bill', 'BillPayment', 'Customer', 'Employee',
          'Estimate', 'Invoice', 'Item', 'JournalEntry', 'Purchase', 'Vendor',
        ]).describe('Entity type (PascalCase)'),
        entityId: z.string().describe('Entity ID'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const { entityType, entityId } = args;
      const result = await qboFetch<Record<string, unknown>>(
        `/${entityType.toLowerCase()}/${encodeURIComponent(entityId)}?minorversion=65`,
      );
      return JSON.stringify({ ok: true, [entityType]: result[entityType] || result });
    }),
  );
}
